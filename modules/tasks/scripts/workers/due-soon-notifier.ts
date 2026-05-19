/**
 * tasks:due-soon-notifier (spec §12.4).
 *
 * Hourly cron. For each task with assignee + due_date in the
 * configured lead window, write a due_soon notification. Idempotent
 * via tasks.due_soon_notified_at.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function runOnce(supabase: SupabaseClient): Promise<{ notified: number }> {
  // Fetch tasks due in the next 48h, not yet notified, with an assignee.
  const horizon = new Date(Date.now() + 48 * 3600_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const { data: tasks } = await supabase
    .from('tasks')
    .select('id, assignee_id, due_date, board_id')
    .not('assignee_id', 'is', null)
    .not('due_date', 'is', null)
    .gte('due_date', today)
    .lte('due_date', horizon)
    .eq('is_done', false)
    .is('deleted_at', null)
    .is('due_soon_notified_at', null);

  let notified = 0;
  for (const task of tasks ?? []) {
    const { data: prefs } = await supabase
      .from('task_user_prefs')
      .select('notify_on_due_soon, due_soon_lead_hours')
      .eq('admin_profile_id', task.assignee_id)
      .maybeSingle();
    const lead = prefs?.due_soon_lead_hours ?? 24;
    const dueAt = new Date(task.due_date as string).getTime();
    if (dueAt - Date.now() > lead * 3600_000) continue;
    if (prefs && prefs.notify_on_due_soon === false) continue;

    await supabase.from('task_notifications').insert({
      recipient_id: task.assignee_id,
      task_id: task.id,
      kind: 'due_soon',
      payload: { due_date: task.due_date },
    });
    await supabase
      .from('tasks')
      .update({ due_soon_notified_at: new Date().toISOString() })
      .eq('id', task.id);
    notified += 1;
  }
  return { notified };
}
