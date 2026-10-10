// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * Schedule-import admin routes (spec-event-agenda-schedule-import §10).
 *
 * Three endpoints behind the platform's /api/modules/<id> JWT prefix:
 * read the import's state, set a manual source URL, and trigger a run.
 */

import type { Request, Response, Router } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hosts an operator may point the importer at (mirrors the fetch allowlist). */
const MANUAL_URL_RE = /^https:\/\/([a-z0-9-]+\.)*(sched\.com|linuxfoundation\.org)(\/|$)/i;

export interface AdminScheduleDeps {
  /** Service role, for the writes RLS intentionally denies to authenticated. */
  supabase: { from(table: string): any };
  /** A client scoped to the caller's own JWT, for the permission check. */
  userClient: (req: Request) => any | null;
  logger: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void };
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

export function mountAdminScheduleRoutes(router: Router, deps: AdminScheduleDeps): void {
  const { supabase, userClient, logger, enqueueJob } = deps;

  /**
   * Per-event authorisation.
   *
   * These handlers use a SERVICE-ROLE client, which bypasses RLS, and the
   * platform's /api/modules/<id> prefix only proves the caller is signed in —
   * it is not a role or ownership check. Without this, any authenticated user
   * could read, re-point or trigger any event's import by guessing a uuid.
   * The check runs as the CALLER (anon key + their bearer token) so it is the
   * same predicate the table's own RLS policy uses, and it fails closed.
   */
  async function denyUnlessEventAdmin(req: Request, res: Response, eventUuid: string): Promise<boolean> {
    const asUser = userClient(req);
    if (!asUser) {
      res.status(401).json({ error: 'session required' });
      return true;
    }
    const { data, error } = await asUser.rpc('can_admin_event', { p_event_uuid: eventUuid });
    if (error) {
      logger.warn('can_admin_event failed', { eventUuid, error: error.message });
      res.status(403).json({ error: 'not permitted for this event' });
      return true;
    }
    if (data !== true) {
      res.status(403).json({ error: 'not permitted for this event' });
      return true;
    }
    return false;
  }

  /** Current import state for an event, plus where its source would come from. */
  router.get('/admin/events/:eventUuid/schedule-import', async (req: Request, res: Response) => {
    const eventUuid = String(req.params.eventUuid ?? '');
    if (!UUID_RE.test(eventUuid)) return res.status(400).json({ error: 'invalid event id' });
    if (await denyUnlessEventAdmin(req, res, eventUuid)) return;

    const { data: row, error } = await supabase
      .from('events_schedule_imports')
      .select('*')
      .eq('event_uuid', eventUuid)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    // When nothing has run yet, show the operator what WOULD be used, so the
    // card can say "from event" rather than a bare "never run".
    let candidate: string | null = row?.schedule_url ?? null;
    if (!candidate) {
      const ev = await supabase.from('events').select('source_details').eq('id', eventUuid).maybeSingle();
      candidate = ev?.data?.source_details?.action_links?.schedule ?? null;
    }

    res.json({
      import: row ?? null,
      candidate_source_url: candidate,
      has_run: !!row?.last_success_at,
    });
  });

  /** Set or clear a manual source URL (spec §5.1 step 2). */
  router.put('/admin/events/:eventUuid/schedule-source', async (req: Request, res: Response) => {
    const eventUuid = String(req.params.eventUuid ?? '');
    if (!UUID_RE.test(eventUuid)) return res.status(400).json({ error: 'invalid event id' });
    if (await denyUnlessEventAdmin(req, res, eventUuid)) return;

    const raw = (req.body as Record<string, unknown> | undefined)?.schedule_url;
    if (raw == null || raw === '') {
      const up = await supabase.from('events_schedule_imports').upsert({
        event_uuid: eventUuid, schedule_url: null, url_origin: 'event',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'event_uuid' });
      if (up.error) return res.status(500).json({ error: up.error.message });
      return res.json({ schedule_url: null, url_origin: 'event' });
    }

    const url = String(raw).trim();
    if (!MANUAL_URL_RE.test(url)) {
      return res.status(400).json({
        error: 'schedule_url must be an https link on sched.com or linuxfoundation.org',
      });
    }
    const up = await supabase.from('events_schedule_imports').upsert({
      event_uuid: eventUuid, schedule_url: url, url_origin: 'manual',
      status: 'pending', error: null, updated_at: new Date().toISOString(),
    }, { onConflict: 'event_uuid' });
    if (up.error) return res.status(500).json({ error: up.error.message });
    logger.info('schedule source set manually', { eventUuid });
    res.json({ schedule_url: url, url_origin: 'manual' });
  });

  /** Queue an import. `force` re-imports even when the hash is unchanged. */
  router.post('/admin/events/:eventUuid/schedule-import', async (req: Request, res: Response) => {
    const eventUuid = String(req.params.eventUuid ?? '');
    if (!UUID_RE.test(eventUuid)) return res.status(400).json({ error: 'invalid event id' });
    if (await denyUnlessEventAdmin(req, res, eventUuid)) return;
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });

    const { data: ev } = await supabase.from('events').select('id').eq('id', eventUuid).maybeSingle();
    if (!ev) return res.status(404).json({ error: 'event not found' });

    // One run at a time; a stuck claim older than 15 minutes is re-claimable
    // by the worker itself, so only a fresh claim blocks here.
    const { data: cur } = await supabase
      .from('events_schedule_imports').select('status, last_attempt_at')
      .eq('event_uuid', eventUuid).maybeSingle();
    if (cur?.status === 'importing') {
      const started = Date.parse(cur.last_attempt_at ?? '') || 0;
      if (Date.now() - started < 15 * 60 * 1000) {
        return res.status(409).json({ error: 'an import is already running for this event' });
      }
    }

    const job = await enqueueJob('jobs', 'event-agenda:import-schedule', {
      kind: 'event-agenda:import-schedule',
      event_uuid: eventUuid,
      force: (req.body as Record<string, unknown> | undefined)?.force === true,
    });
    logger.info('schedule import queued', { eventUuid, job: job.id });
    res.status(202).json({ job_id: job.id, status: 'queued' });
  });
}
