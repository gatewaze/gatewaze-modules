// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * event-agenda:backfill-schedules — the one-off sweep over past conferences
 * (spec-event-agenda-schedule-import §6.5).
 *
 * The nightly sweep keeps the recent window fresh. This is the other job: read
 * every past conference once, so the speaker database is built in bulk instead
 * of one conference at a time.
 *
 * It is a drain, not a long-running loop. Each invocation does `batch_size`
 * events and then re-enqueues itself, which is what makes "pause" one UPDATE
 * on the run row rather than killing a job. It is also what makes a worker
 * restart harmless: the next invocation reads the run row and carries on.
 *
 * §6.5's warning drives the review gate. A backfill is where two different
 * "Chris Wilson"s are most likely to be merged into one person, and where
 * nobody is watching. So by default it stops every 5 events and waits for an
 * operator to look at the speaker counts before it carries on.
 */

import {
  selectBatch,
  shouldPauseForReview,
  cursorFilterValue,
  advanceCursor,
  itemStatus,
  counterFor,
  reviewCounts,
  type CandidateEvent,
  type ImportState,
} from '../lib/backfill.js';

/** Between imports, per §5.4. Same pacing as the nightly sweep. */
const PACE_MS = 1000;
/** Scope-query page size. Past conferences number in the hundreds, not millions. */
const PAGE = 500;
/** PostgREST `in.(...)` rides in the query string, so chunk the lookups. */
const IN_CHUNK = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Past conferences, oldest first, from the cursor onwards.
 *
 * The cursor is a `>=` filter rather than a `>` so an event sharing a start
 * timestamp with the last one processed is not skipped. The duplicate that
 * causes is removed by the run's own item rows, which selectBatch already
 * consults, so the overlap costs one row read and never a second import.
 */
async function loadCandidates(supabase, run, now: Date): Promise<CandidateEvent[]> {
  let q = supabase
    .from('events')
    .select('id, event_start, source_details')
    .eq('event_type', 'conference')
    .lt('event_start', now.toISOString())
    .order('event_start', { ascending: true })
    .limit(PAGE);

  const from = cursorFilterValue(run);
  if (from) q = q.gte('event_start', from);

  const res = await q;
  if (res.error) throw new Error(`scope query failed: ${res.error.message}`);
  return (res.data ?? []).map((r) => ({
    id: String(r.id),
    event_start: r.event_start ?? null,
    eventScheduleUrl: r.source_details?.action_links?.schedule
      ? String(r.source_details.action_links.schedule)
      : null,
  }));
}

/** The import rows for a set of events, keyed by event. */
async function loadImportStates(supabase, eventIds: string[]): Promise<Map<string, ImportState>> {
  const out = new Map<string, ImportState>();
  for (const chunk of chunks(eventIds.filter((id) => UUID_RE.test(id)), IN_CHUNK)) {
    const res = await supabase
      .from('events_schedule_imports')
      .select('event_uuid, status, schedule_url, url_origin, last_success_at')
      .in('event_uuid', chunk);
    if (res.error) throw new Error(`import states unreadable: ${res.error.message}`);
    for (const r of res.data ?? []) {
      out.set(String(r.event_uuid), {
        status: r.status ?? null,
        schedule_url: r.schedule_url ?? null,
        url_origin: r.url_origin ?? null,
        last_success_at: r.last_success_at ?? null,
      });
    }
  }
  return out;
}

/** Events this run has already attempted. */
async function loadProcessed(supabase, runId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const res = await supabase
    .from('events_schedule_backfill_items')
    .select('event_uuid')
    .eq('run_id', runId);
  if (res.error) throw new Error(`run items unreadable: ${res.error.message}`);
  for (const r of res.data ?? []) out.add(String(r.event_uuid));
  return out;
}

/**
 * How many events are in scope right now, for a progress reading.
 *
 * Deliberately a count over the whole scope rather than the remaining page:
 * the admin card shows "47 of 312", and 312 has to mean the same thing on
 * every batch. Cheap enough to redo each batch, and it self-corrects when the
 * scope changes under a long run.
 */
async function countScope(supabase, now: Date): Promise<number | null> {
  const res = await supabase
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'conference')
    .lt('event_start', now.toISOString());
  return res.error ? null : (res.count ?? null);
}

export interface BackfillTickResult {
  state: string;
  attempted: number;
  reason?: string;
}

/**
 * One batch. Returns the state the run is in afterwards, so the handler knows
 * whether to re-enqueue.
 */
export async function runBackfillBatch(
  supabase,
  runId: string,
  log: (m: string) => void = () => {},
  now: Date = new Date(),
): Promise<BackfillTickResult> {
  if (!UUID_RE.test(String(runId ?? ''))) return { state: 'cancelled', attempted: 0, reason: 'invalid run id' };

  const runRes = await supabase
    .from('events_schedule_backfill_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();
  if (runRes.error) throw new Error(`run unreadable: ${runRes.error.message}`);
  const run = runRes.data;
  if (!run) return { state: 'cancelled', attempted: 0, reason: 'run not found' };

  // The pause. An operator sets state to 'paused' and the drain stops after
  // the batch in flight, with no job to find and kill.
  if (run.state !== 'running') {
    log(`backfill ${runId} is ${run.state} — nothing to do`);
    return { state: run.state, attempted: 0, reason: `run is ${run.state}` };
  }

  const candidates = await loadCandidates(supabase, run, now);
  const processed = await loadProcessed(supabase, runId);
  const imports = await loadImportStates(supabase, candidates.map((c) => c.id));
  const batch = selectBatch(candidates, imports, processed, {
    batchSize: Math.max(1, Number(run.batch_size) || 5),
    retryUnavailable: run.retry_unavailable === true,
    forceReimport: run.force_reimport === true,
  });

  if (batch.length === 0) {
    // Nothing left in scope. A page-sized scope read means this is only
    // conclusive when the page was not full; a full page with everything
    // already processed just means the cursor has to move on.
    if (candidates.length >= PAGE) {
      const moved = advanceCursor(run, candidates.slice(-1));
      await supabase
        .from('events_schedule_backfill_runs')
        .update({ ...moved, updated_at: new Date().toISOString() })
        .eq('id', runId);
      log('backfill: page exhausted, cursor advanced');
      return { state: 'running', attempted: 0, reason: 'cursor advanced' };
    }
    await supabase
      .from('events_schedule_backfill_runs')
      .update({
        state: 'complete',
        pause_reason: null,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', runId);
    log(`backfill ${runId} complete — ${run.processed} event(s) attempted`);
    return { state: 'complete', attempted: 0 };
  }

  const { importSchedule } = await import('./import-schedule.js');

  const totals = {
    processed: Number(run.processed) || 0,
    complete_count: Number(run.complete_count) || 0,
    unavailable_count: Number(run.unavailable_count) || 0,
    failed_count: Number(run.failed_count) || 0,
  };
  const processedBefore = totals.processed;

  for (const ev of batch) {
    let status = 'errored';
    let stats: Record<string, unknown> = {};
    let error: string | null = null;
    try {
      const res = await importSchedule(supabase, ev.id, {
        force: run.force_reimport === true,
        log: () => {},
      });
      status = itemStatus(res?.status);
      stats = (res?.stats ?? {}) as Record<string, unknown>;
      error = res?.error ? String(res.error).slice(0, 2000) : null;
    } catch (err) {
      // One bad event must not end the run. It is recorded as 'errored' and
      // the drain moves on, which is the whole reason the item table exists.
      error = String((err as Error)?.message ?? err).slice(0, 2000);
      log(`backfill: ${ev.id} errored (${error.slice(0, 160)})`);
    }

    const item = await supabase.from('events_schedule_backfill_items').upsert({
      run_id: runId,
      event_uuid: ev.id,
      status,
      ...reviewCounts(stats),
      error,
      event_start: ev.event_start,
      processed_at: new Date().toISOString(),
    }, { onConflict: 'run_id,event_uuid' });
    if (item.error) log(`backfill: could not record item for ${ev.id} (${item.error.message})`);

    totals.processed += 1;
    const counter = counterFor(status);
    if (counter) totals[counter] += 1;

    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  const pause = shouldPauseForReview(processedBefore, totals.processed, Number(run.review_every) || 0);
  const patch: Record<string, unknown> = {
    ...totals,
    ...advanceCursor(run, batch),
    scope_total: (await countScope(supabase, now)) ?? run.scope_total ?? null,
    updated_at: new Date().toISOString(),
  };
  if (pause) {
    patch.state = 'paused';
    patch.pause_reason = 'review';
  }

  // Re-read the state immediately before writing, so an operator who paused
  // mid-batch is not overwritten back to 'running' by this update. The state
  // column is only written here when the review gate fires.
  const current = await supabase
    .from('events_schedule_backfill_runs').select('state').eq('id', runId).maybeSingle();
  if (current?.data?.state !== 'running') {
    delete patch.state;
    delete patch.pause_reason;
  }
  const upd = await supabase.from('events_schedule_backfill_runs').update(patch).eq('id', runId);
  if (upd.error) throw new Error(`run update failed: ${upd.error.message}`);

  const after = current?.data?.state !== 'running'
    ? String(current?.data?.state ?? 'paused')
    : (pause ? 'paused' : 'running');
  log(
    `backfill: ${batch.length} event(s) attempted — ${totals.complete_count} complete, ` +
    `${totals.unavailable_count} unavailable, ${totals.failed_count} failed ` +
    `(${totals.processed} of ${patch.scope_total ?? '?'} so far)` +
    (after === 'paused' ? ' — paused for review' : ''),
  );
  return { state: after, attempted: batch.length };
}

export default async function backfillSchedulesHandler(job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[event-agenda] ${m}`);

  const runId = String(job?.data?.run_id ?? job?.data?.runId ?? '');
  if (!UUID_RE.test(runId)) {
    log('backfill: no run_id on the job — nothing to do');
    return;
  }

  const result = await runBackfillBatch(supabase, runId, log);

  // The drain. Only a 'running' run gets another job, so pausing, completing
  // and cancelling all stop it without anything to clean up.
  if (result.state !== 'running') return;
  const enqueue = ctx?.enqueueJob;
  if (typeof enqueue !== 'function') {
    log('backfill: no enqueueJob in worker ctx — the run will resume on the next manual trigger');
    return;
  }
  await enqueue('jobs', 'event-agenda:backfill-schedules', {
    kind: 'event-agenda:backfill-schedules',
    run_id: runId,
  });
}
