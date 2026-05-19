/**
 * tasks:recurrence-spawner worker (spec §12.1).
 *
 * Runs every 5 minutes via BullMQ repeat. Scans completed
 * recurrence templates, computes their next occurrence, and
 * deep-clones the subtree as a new instance.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { nextOccurrence } from '../../lib/rrule.js';

interface Task {
  id: string;
  board_id: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status_id: string | null;
  assignee_id: string | null;
  priority: string | null;
  estimate_hours: number | null;
  start_date: string | null;
  due_date: string | null;
  sort_index: string;
  recurrence_rule: string | null;
  recurrence_parent_id: string | null;
}

export async function runOnce(supabase: SupabaseClient): Promise<{ spawned: number }> {
  // Find done templates.
  const { data: templates } = await supabase
    .from('tasks')
    .select('*')
    .not('recurrence_rule', 'is', null)
    .is('recurrence_parent_id', null)
    .eq('is_done', true)
    .is('deleted_at', null);

  let spawned = 0;
  for (const tmpl of (templates ?? []) as Task[]) {
    const afterDate = tmpl.due_date ? new Date(tmpl.due_date) : new Date();
    const next = nextOccurrence(tmpl.recurrence_rule!, afterDate);
    if (!next) continue;

    // Dedupe via recurrence_state.
    const { data: state } = await supabase
      .from('task_recurrence_state')
      .select('last_spawned_occurrence')
      .eq('template_task_id', tmpl.id)
      .maybeSingle();
    const nextIso = next.toISOString().slice(0, 10);
    if (state?.last_spawned_occurrence === nextIso) continue;

    // Deep-clone the subtree.
    await cloneSubtree(supabase, tmpl, next);

    // Reset the template back to non-done so it can fire again.
    const { data: defaultStatus } = await supabase
      .from('board_statuses')
      .select('id')
      .eq('board_id', tmpl.board_id)
      .eq('is_default', true)
      .maybeSingle();
    if (defaultStatus) {
      await supabase.from('tasks').update({ status_id: defaultStatus.id }).eq('id', tmpl.id);
    }

    // Track in state.
    await supabase.from('task_recurrence_state').upsert({
      template_task_id: tmpl.id,
      last_spawned_at: new Date().toISOString(),
      last_spawned_occurrence: nextIso,
    });

    await supabase.from('task_activity').insert({
      task_id: tmpl.id,
      actor_id: null,
      event_type: 'recurrence_spawned',
      payload: { occurrence: nextIso },
    });
    spawned += 1;
  }
  return { spawned };
}

async function cloneSubtree(supabase: SupabaseClient, root: Task, occurrence: Date): Promise<void> {
  // Pull the whole subtree (recursive CTE via RPC, or fetch flat and walk locally).
  // For v1 we keep it simple: fetch all descendants in one query then walk.
  const { data: descendants } = await supabase
    .from('tasks')
    .select('*')
    .eq('board_id', root.board_id)
    .is('deleted_at', null);
  const idMap = new Map<string, string>();
  // Build a parent → children map for walking.
  const all = (descendants ?? []) as Task[];
  const childMap = new Map<string | null, Task[]>();
  for (const t of all) {
    const k = t.parent_task_id;
    let list = childMap.get(k);
    if (!list) { list = []; childMap.set(k, list); }
    list.push(t);
  }
  const subtree: Task[] = [];
  function walk(id: string) {
    for (const child of childMap.get(id) ?? []) {
      subtree.push(child);
      walk(child.id);
    }
  }
  walk(root.id);
  // Allocate new ids.
  for (const t of [root, ...subtree]) {
    idMap.set(t.id, crypto.randomUUID());
  }
  // Compute date shift.
  const rootDue = root.due_date ? new Date(root.due_date) : new Date();
  const shiftDays = Math.round((occurrence.getTime() - rootDue.getTime()) / 86400000);

  // Build insert rows.
  const inserts = [root, ...subtree].map(t => ({
    id: idMap.get(t.id)!,
    board_id: t.board_id,
    parent_task_id: t.parent_task_id === root.id || t.parent_task_id === null
      ? (t.id === root.id ? null : idMap.get(root.id)!)
      : idMap.get(t.parent_task_id ?? '') ?? null,
    title: t.title,
    description: t.description,
    status_id: t.status_id,
    assignee_id: t.assignee_id,
    priority: t.priority,
    estimate_hours: t.estimate_hours,
    start_date: t.start_date ? shiftDate(t.start_date, shiftDays) : null,
    due_date: t.due_date ? shiftDate(t.due_date, shiftDays) : null,
    sort_index: t.sort_index,
    recurrence_parent_id: t.id === root.id ? root.id : null,
  }));
  // Exclude the root from inserts — we already have it; insert children only.
  await supabase.from('tasks').insert(inserts.slice(1));
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
