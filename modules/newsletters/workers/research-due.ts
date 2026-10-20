/**
 * Cron (every 5 min): create and enqueue the research runs that are due, and
 * sweep stale ones. spec-content-discovery-and-research-blocks.md §5.3.
 *
 *   * `edition` blocks: every draft edition whose effective research time
 *     (newsletters_effective_research_at) has passed gets one `queued` run
 *     per research block that has no run with the same `scheduled_for`.
 *   * `daily` blocks (data.daily=true, the 06:00 cron): one run per day per
 *     block on draft editions whose send target is still ahead.
 *   * The row is INSERTED HERE; the one-in-flight index refuses a second,
 *     so a backlog of ticks cannot double the AI spend.
 *   * Stale sweep: `running` for more than 30 minutes → failed/stale.
 */

import type { Job } from 'bullmq';
import { redisConnection } from '../lib/redis-connection.js';
import { createClient } from '@supabase/supabase-js';

interface DueJobData { kind: string; daily?: boolean }

const STALE_MINUTES = 30;

export default async function handleResearchDue(job: Job<DueJobData>) {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const daily = job.data?.daily === true;
  const log = (m: string) => console.log(`[newsletters:research-due${daily ? ' daily' : ''}] ${m}`);

  // 1. Stale sweep.
  const staleBefore = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
  const { data: stale } = await sb.from('newsletters_research_runs').select('id').eq('status', 'running').lt('started_at', staleBefore).limit(50);
  for (const s of (stale ?? []) as Array<{ id: string }>) {
    await sb.from('newsletters_research_runs').update({ status: 'failed', failure_kind: 'stale', error: `no completion after ${STALE_MINUTES} minutes; the worker that held it is gone` }).eq('id', s.id).eq('status', 'running');
    log(`swept stale run ${s.id}`);
  }
  // A queued row never picked up (Redis down at enqueue) would hold the
  // one-in-flight slot and the send gate forever; after 10 minutes it is a failure.
  const queuedBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: orphans } = await sb.from('newsletters_research_runs').select('id').eq('status', 'queued').lt('created_at', queuedBefore).limit(50);
  for (const o of (orphans ?? []) as Array<{ id: string }>) {
    await sb.from('newsletters_research_runs').update({ status: 'cancelled', error: 'never picked up by a worker within 10 minutes' }).eq('id', o.id).eq('status', 'queued');
    log(`cancelled orphaned queued run ${o.id}`);
  }

  // 2. Candidate editions: drafts with a send target.
  const nowIso = new Date().toISOString();
  const { data: editions, error } = await sb
    .from('newsletters_editions')
    .select('id, send_target_at, research_at, collection_id')
    .eq('status', 'draft')
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

      // Already satisfied for this scheduled_for?
      const { data: existing } = await sb.from('newsletters_research_runs').select('id').eq('block_id', b.id).eq('scheduled_for', scheduledFor).limit(1);
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
        await enqueueRun(runId);
        created++;
      } catch (e) {
        await sb.from('newsletters_research_runs').update({ status: 'failed', failure_kind: 'other', error: `enqueue failed: ${e instanceof Error ? e.message : String(e)}` }).eq('id', runId).eq('status', 'queued');
        log(`enqueue failed for run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (created) log(`enqueued ${created} run(s)`);
}

async function enqueueRun(runId: string) {
  const { Queue } = await import('bullmq');
  const queue = new Queue('jobs', { connection: redisConnection(), prefix: `bull:${process.env.BRAND || 'default'}` });
  try {
    await queue.add('newsletters:research-run', { kind: 'newsletters:research-run', runId }, { jobId: `newsletters-research-run-${runId}`, attempts: 2, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: { count: 500 }, removeOnFail: { count: 500 } });
  } finally {
    await queue.close().catch(() => {});
  }
}
