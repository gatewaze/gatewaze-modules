// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * Backfill admin routes (spec-event-agenda-schedule-import §6.5).
 *
 * Four endpoints: read the live run, start one, change its state, and list its
 * items for the review §6.5 asks for.
 *
 * Authorisation is is_admin(), not can_admin_event(). A backfill is global. An
 * event organiser with rights to one event must not be able to start a run
 * that reads every other event, nor read the item rows, which carry every
 * event's import outcome.
 */

import type { Request, Response, Router } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** States an operator may set, and what each means for the drain. */
const OPERATOR_STATES = new Set(['running', 'paused', 'cancelled']);
/** Item statuses the review listing may filter on. */
const ITEM_STATUSES = new Set(['complete', 'unavailable', 'failed', 'skipped', 'errored']);

const LIMITS = {
  batchSize: { min: 1, max: 50, default: 5 },
  reviewEvery: { min: 0, max: 10000, default: 5 },
  items: { min: 1, max: 200, default: 50 },
};

export interface AdminBackfillDeps {
  /** Service role, for the writes RLS intentionally denies to authenticated. */
  supabase: { from(table: string): any };
  /** A client scoped to the caller's own JWT, for the permission check. */
  userClient: (req: Request) => any | null;
  logger: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void };
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

/** A bounded integer from request JSON, or the default. Never NaN, never huge. */
function boundedInt(raw: unknown, { min, max, default: dflt }: { min: number; max: number; default: number }): number {
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export function mountAdminBackfillRoutes(router: Router, deps: AdminBackfillDeps): void {
  const { supabase, userClient, logger, enqueueJob } = deps;

  /**
   * Global admin check, run as the CALLER.
   *
   * The /api/modules/<id> prefix only proves the caller is signed in. With a
   * service-role client behind it, that is not enough: see the per-event
   * version of this in admin-routes.ts for the same reasoning. Fails closed.
   */
  async function denyUnlessAdmin(req: Request, res: Response): Promise<boolean> {
    const asUser = userClient(req);
    if (!asUser) {
      res.status(401).json({ error: 'session required' });
      return true;
    }
    const { data, error } = await asUser.rpc('is_admin');
    if (error) {
      logger.warn('is_admin failed', { error: error.message });
      res.status(403).json({ error: 'admin only' });
      return true;
    }
    if (data !== true) {
      res.status(403).json({ error: 'admin only' });
      return true;
    }
    return false;
  }

  /** The live run (running or paused), with its counts. */
  router.get('/admin/schedule-backfill', async (req: Request, res: Response) => {
    if (await denyUnlessAdmin(req, res)) return;

    const { data: run, error } = await supabase
      .from('events_schedule_backfill_runs')
      .select('*')
      .in('state', ['running', 'paused'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    const { data: last } = await supabase
      .from('events_schedule_backfill_runs')
      .select('id, state, processed, complete_count, unavailable_count, failed_count, finished_at')
      .in('state', ['complete', 'cancelled'])
      .order('finished_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    res.json({ run: run ?? null, last_finished: last ?? null });
  });

  /** Start a run. Refused when one is already live, because they share a cursor. */
  router.post('/admin/schedule-backfill', async (req: Request, res: Response) => {
    if (await denyUnlessAdmin(req, res)) return;
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });

    const { data: live } = await supabase
      .from('events_schedule_backfill_runs')
      .select('id, state')
      .in('state', ['running', 'paused'])
      .limit(1)
      .maybeSingle();
    if (live) {
      return res.status(409).json({
        error: `a backfill is already ${live.state}`,
        run_id: live.id,
      });
    }

    // Allowlisted explicitly. req.body is never spread into an insert.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const insert = {
      state: 'running',
      batch_size: boundedInt(body.batch_size, LIMITS.batchSize),
      review_every: boundedInt(body.review_every, LIMITS.reviewEvery),
      retry_unavailable: body.retry_unavailable === true,
      force_reimport: body.force_reimport === true,
      requested_by: await callerUserId(req),
    };

    const { data: run, error } = await supabase
      .from('events_schedule_backfill_runs')
      .insert(insert)
      .select('*')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const job = await enqueueJob('jobs', 'event-agenda:backfill-schedules', {
      kind: 'event-agenda:backfill-schedules',
      run_id: run.id,
    });
    logger.info('schedule backfill started', { run: run.id, job: job.id });
    res.status(202).json({ run, job_id: job.id });
  });

  /**
   * Pause, resume or cancel.
   *
   * Resuming re-enqueues the drain, because the worker only re-enqueues itself
   * while the run is 'running' — a paused run has no job waiting for it.
   */
  router.put('/admin/schedule-backfill/:runId/state', async (req: Request, res: Response) => {
    if (await denyUnlessAdmin(req, res)) return;
    const runId = String(req.params.runId ?? '');
    if (!UUID_RE.test(runId)) return res.status(400).json({ error: 'invalid run id' });

    const state = String((req.body as Record<string, unknown> | undefined)?.state ?? '');
    if (!OPERATOR_STATES.has(state)) {
      return res.status(400).json({ error: 'state must be running, paused or cancelled' });
    }

    const { data: run, error: readErr } = await supabase
      .from('events_schedule_backfill_runs')
      .select('id, state')
      .eq('id', runId)
      .maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!run) return res.status(404).json({ error: 'run not found' });
    if (run.state === 'complete' || run.state === 'cancelled') {
      return res.status(409).json({ error: `run is already ${run.state}` });
    }

    const patch: Record<string, unknown> = {
      state,
      pause_reason: state === 'paused' ? 'operator' : null,
      updated_at: new Date().toISOString(),
    };
    if (state === 'cancelled') patch.finished_at = new Date().toISOString();

    const { error } = await supabase
      .from('events_schedule_backfill_runs').update(patch).eq('id', runId);
    if (error) return res.status(500).json({ error: error.message });

    let jobId: string | undefined;
    if (state === 'running') {
      if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
      const job = await enqueueJob('jobs', 'event-agenda:backfill-schedules', {
        kind: 'event-agenda:backfill-schedules',
        run_id: runId,
      });
      jobId = job.id;
    }
    logger.info('schedule backfill state changed', { run: runId, state });
    res.json({ run_id: runId, state, ...(jobId ? { job_id: jobId } : {}) });
  });

  /** The review listing: what the run did to each event, newest first. */
  router.get('/admin/schedule-backfill/:runId/items', async (req: Request, res: Response) => {
    if (await denyUnlessAdmin(req, res)) return;
    const runId = String(req.params.runId ?? '');
    if (!UUID_RE.test(runId)) return res.status(400).json({ error: 'invalid run id' });

    const limit = boundedInt(req.query.limit, LIMITS.items);
    let q = supabase
      .from('events_schedule_backfill_items')
      .select('*')
      .eq('run_id', runId)
      .order('processed_at', { ascending: false })
      .limit(limit);

    // Allowlisted against a Set, not interpolated. An unknown value is a 400
    // rather than a silently unfiltered listing.
    const status = req.query.status;
    if (status != null && status !== '') {
      const s = String(status);
      if (!ITEM_STATUSES.has(s)) return res.status(400).json({ error: 'unknown status filter' });
      q = q.eq('status', s);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data ?? [] });
  });

  /**
   * The caller's auth user id, for the audit column.
   *
   * Read from the token through getUser() rather than decoded here, so a
   * forged `sub` cannot land in requested_by. A failure is null, because an
   * audit column must never be the reason a request fails.
   */
  async function callerUserId(req: Request): Promise<string | null> {
    try {
      const asUser = userClient(req);
      if (!asUser) return null;
      const { data } = await asUser.auth.getUser();
      const id = data?.user?.id;
      return UUID_RE.test(String(id ?? '')) ? String(id) : null;
    } catch {
      return null;
    }
  }
}
