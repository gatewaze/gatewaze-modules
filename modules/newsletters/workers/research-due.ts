/**
 * Cron (every 5 min): create and enqueue the research runs that are due, and
 * sweep stale ones. spec-content-discovery-and-research-blocks.md §5.3.
 *
 *   * `edition` blocks: every open edition (a draft, or a published edition
 *     that has not started sending; newsletters_edition_research_open) whose
 *     effective research time (newsletters_effective_research_at) has passed
 *     gets one `queued` run per research block that has no run with the same
 *     `scheduled_for`. A run the system cancelled (enqueue failed, never
 *     picked up) does not satisfy the slot, so it is retried; one an admin
 *     cancelled does.
 *   * `daily` blocks (data.daily=true, the 06:00 cron): one run per day per
 *     block on open editions whose send target is still ahead.
 *   * The row is INSERTED HERE; the one-in-flight index refuses a second,
 *     so a backlog of ticks cannot double the AI spend.
 *   * Stale sweep: `running` for more than 30 minutes → failed/stale.
 *
 * Cancellations written here carry failure_kind 'other'; an admin cancel
 * (research-routes) carries none. That is how the slot check tells them apart.
 */

import type { Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';

interface DueJobData { kind: string; daily?: boolean }

const STALE_MINUTES = 30;

/** The platform's enqueue helper, passed to worker handlers (lib/queue/registry.ts). */
type EnqueueJob = (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string | undefined }>;

export default async function handleResearchDue(job: Job<DueJobData>, ctx?: { enqueueJob?: EnqueueJob }) {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const daily = job.data?.daily === true;
  const log = (m: string) => console.log(`[newsletters:research-due${daily ? ' daily' : ''}] ${m}`);

  // 1. Stale sweep.
  const staleBefore = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
  const { data: stale } = await sb.from('newsletters_research_runs').select('id').eq('status', 'running').lt('started_at', staleBefore).limit(50);
  for (const s of (stale ?? []) as Array<{ id: string }>) {
    const { error: sErr } = await sb.from('newsletters_research_runs').update({ status: 'failed', failure_kind: 'stale', error: `no completion after ${STALE_MINUTES} minutes; the worker that held it is gone` }).eq('id', s.id).eq('status', 'running');
    log(sErr ? `could not sweep stale run ${s.id}: ${sErr.message}` : `swept stale run ${s.id}`);
  }
  // A queued row never picked up (Redis down at enqueue) would hold the
  // one-in-flight slot and the send gate forever; after 10 minutes it is a failure.
  const queuedBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: orphans } = await sb.from('newsletters_research_runs').select('id').eq('status', 'queued').lt('created_at', queuedBefore).limit(50);
  for (const o of (orphans ?? []) as Array<{ id: string }>) {
    const { error: oErr } = await sb.from('newsletters_research_runs').update({ status: 'cancelled', failure_kind: 'other', error: 'never picked up by a worker within 10 minutes' }).eq('id', o.id).eq('status', 'queued');
    log(oErr ? `could not cancel orphaned queued run ${o.id}: ${oErr.message}` : `cancelled orphaned queued run ${o.id}`);
  }

  // 2. Candidate editions: drafts and published editions with a send target.
  // Sending requires published, so a scheduled send's research lands on a
  // published edition; whether it has started going out is checked per
  // edition below (the write RPC checks it again).
  const nowIso = new Date().toISOString();
  const { data: editions, error } = await sb
    .from('newsletters_editions')
    .select('id, send_target_at, research_at, collection_id')
    .in('status', ['draft', 'published'])
    .not('send_target_at', 'is', null)
    // Abandoned old drafts must not starve current editions: look back 30 days only, newest first.
    .gte('send_target_at', daily ? nowIso : new Date(Date.now() - 30 * 86_400_000).toISOString())
    .order('send_target_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(`[newsletters:research-due] editions query failed: ${error.message}`);

  let created = 0;
  for (const ed of (editions ?? []) as Array<{ id: string; send_target_at: string; research_at: string | null; collection_id: string | null }>) {
    const { data: effective } = await sb.rpc('newsletters_effective_research_at', { p_edition_id: ed.id });
    const researchAt = typeof effective === 'string' ? effective : null;
    if (!daily && (!researchAt || researchAt > nowIso)) continue;
    const { data: open, error: openErr } = await sb.rpc('newsletters_edition_research_open', { p_edition_id: ed.id });
    if (openErr) { log(`open check failed for edition ${ed.id}: ${openErr.message}`); continue; }
    if (open !== true) continue; // it has started sending (or is archived): research is over

    const { data: blocks } = await sb
      .from('newsletters_edition_blocks')
      .select('id, templates_block_def_id, templates_block_defs!templates_block_def_id(id, source_kind, data_source)')
      .eq('edition_id', ed.id)
      .is('deleted_at', null);
    for (const b of (blocks ?? []) as unknown as Array<{ id: string; templates_block_def_id: string | null; templates_block_defs: { id: string; source_kind: string; data_source: Record<string, unknown> | null } | null }>) {
      const def = b.templates_block_defs;
      if (!def || def.source_kind !== 'research' || !def.data_source) continue;
      const schedule = (def.data_source.schedule as string | undefined) ?? 'edition';
      if (daily ? schedule !== 'daily' : schedule !== 'edition') continue;
      const scheduledFor = daily ? new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z' : researchAt!;

      // Already satisfied for this scheduled_for? A system cancellation
      // (failure_kind set) does not count, so the slot is retried.
      const { data: existing, error: exErr } = await sb
        .from('newsletters_research_runs')
        .select('id')
        .eq('block_id', b.id)
        .eq('scheduled_for', scheduledFor)
        .or('status.neq.cancelled,failure_kind.is.null')
        .limit(1);
      if (exErr) { log(`run lookup failed for block ${b.id}: ${exErr.message}`); continue; }
      if (existing && existing.length) continue;

      const ins = await sb
        .from('newsletters_research_runs')
        .insert({ edition_id: ed.id, block_id: b.id, block_def_id: def.id, binding: def.data_source, binding_hash: 'pending', triggered_by: daily ? 'daily' : 'schedule', scheduled_for: scheduledFor, status: 'queued' })
        .select('id')
        .maybeSingle();
      if (ins.error) {
        if (/one_inflight|duplicate key/i.test(ins.error.message)) continue; // a run is already in flight for this block
        log(`insert failed for block ${b.id}: ${ins.error.message}`);
        continue;
      }
      const runId = (ins.data as { id: string }).id;
      try {
        await enqueueRun(runId, ctx?.enqueueJob);
        created++;
      } catch (e) {
        // queued → cancelled (the 093 guard refuses queued → failed). It frees
        // the one-in-flight slot and, carrying failure_kind, is retried next tick.
        const msg = e instanceof Error ? e.message : String(e);
        const { error: cErr } = await sb.from('newsletters_research_runs').update({ status: 'cancelled', failure_kind: 'other', error: `enqueue failed: ${msg}` }).eq('id', runId).eq('status', 'queued');
        log(`enqueue failed for run ${runId}: ${msg}${cErr ? `; could not cancel it either: ${cErr.message}` : ''}`);
      }
    }
  }
  if (created) log(`enqueued ${created} run(s)`);
}

// Through the platform's enqueueJob, not a direct bullmq import: the module
// is loaded from its own directory, where ESM import('bullmq') cannot resolve.
async function enqueueRun(runId: string, enqueueJob: EnqueueJob | undefined) {
  if (typeof enqueueJob !== 'function') throw new Error('no enqueueJob in the worker context');
  const { id } = await enqueueJob('jobs', 'newsletters:research-run', { kind: 'newsletters:research-run', runId }, RUN_JOB_OPTS(runId));
  if (!id) throw new Error('the jobs queue is not registered in this worker');
}

const RUN_JOB_OPTS = (runId: string) => ({ jobId: `newsletters-research-run-${runId}`, attempts: 2, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: { count: 500 }, removeOnFail: { count: 500 } });
