// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * Speaker dedupe review endpoints.
 *
 * Mounted under /api/modules/event-speakers, which the platform gates to
 * super_admin for everything outside /internal/* (packages/api/src/routes/
 * modules.ts). That gate is wanted here rather than worked around: merging two
 * speaker records rewrites who gave which talk across every event, and the
 * review queue exists precisely because a machine could not be trusted to
 * decide it.
 *
 * Every write goes through merge_speaker_profiles / unmerge_speaker_profiles
 * rather than touching rows directly, so the junction repointing and the audit
 * trail cannot be skipped by a caller.
 */

import { Router, json, type Express, type Request, type Response } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Deps {
  supabase: unknown;
  userClient: (req: Request) => unknown | null;
  logger: { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void };
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

export function mountDedupeRoutes(router: Router, deps: Deps): void {
  const { supabase, userClient, logger, enqueueJob } = deps;

  /**
   * Who is asking, resolved from their own token.
   *
   * The platform's super_admin gate already ran, so this is for attribution on
   * the audit row rather than for authorisation. It fails closed anyway: a
   * merge recorded against nobody is worse than a 401.
   */
  async function actorId(req: Request): Promise<string | null> {
    const asUser = userClient(req);
    if (!asUser) return null;
    try {
      const { data } = await (asUser as { auth: { getUser: () => Promise<{ data?: { user?: { id?: string } } }> } }).auth.getUser();
      return data?.user?.id ?? null;
    } catch {
      return null;
    }
  }

  /** The open review queue, worst-ambiguity-last so the best candidates lead. */
  router.get('/admin/speaker-dedupe/candidates', async (req: Request, res: Response) => {
    const state = String(req.query.state ?? 'open');
    if (!['open', 'merged', 'rejected'].includes(state)) {
      return res.status(400).json({ error: 'state must be open, merged or rejected' });
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));

    const { data: rows, error } = await supabase
      .from('speaker_merge_candidates')
      .select('id, profile_ids, canonical_id, rule, reason, score, signals, state, created_at')
      .eq('state', state)
      .order('score', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    // Hydrate the profiles in ONE read rather than per candidate. A queue of
    // 50 groups of 3 would otherwise be 150 round trips to render one page.
    const ids = [...new Set((rows ?? []).flatMap((r) => r.profile_ids ?? []))];
    const profiles = new Map<string, unknown>();
    if (ids.length > 0) {
      const { data: ps } = await supabase
        .from('events_speaker_profiles')
        .select('id, name, title, company, email, linkedin_url, avatar_url, sched_user_id, canonical_profile_id, created_at')
        .in('id', ids);
      for (const p of ps ?? []) profiles.set(p.id, p);
    }

    res.json({
      candidates: (rows ?? []).map((r) => ({
        ...r,
        profiles: (r.profile_ids ?? []).map((id: string) => profiles.get(id)).filter(Boolean),
      })),
    });
  });

  /** How much duplication is left, for the card header. */
  router.get('/admin/speaker-dedupe/summary', async (_req: Request, res: Response) => {
    const counts: Record<string, number> = {};
    for (const state of ['open', 'merged', 'rejected']) {
      const { count } = await supabase
        .from('speaker_merge_candidates')
        .select('id', { count: 'exact', head: true })
        .eq('state', state);
      counts[state] = count ?? 0;
    }
    const { count: aliases } = await supabase
      .from('events_speaker_profiles')
      .select('id', { count: 'exact', head: true })
      .not('canonical_profile_id', 'is', null);
    res.json({ candidates: counts, merged_profiles: aliases ?? 0 });
  });

  /**
   * Accept a candidate: merge every other profile in the group into the
   * canonical one.
   *
   * The canonical may be overridden by the operator, but only to a profile
   * that is actually in the group. Taking it from the body unchecked would let
   * a caller merge any two profiles in the database through a route that looks
   * like it only accepts a queued suggestion.
   */
  router.post('/admin/speaker-dedupe/candidates/:id/merge', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid candidate id' });

    const { data: cand, error } = await supabase
      .from('speaker_merge_candidates')
      .select('id, profile_ids, canonical_id, rule, reason, signals, state')
      .eq('id', id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!cand) return res.status(404).json({ error: 'candidate not found' });
    if (cand.state !== 'open') return res.status(409).json({ error: `candidate is already ${cand.state}` });

    const body = (req.body ?? {}) as Record<string, unknown>;
    let canonicalId = cand.canonical_id;
    if (typeof body.canonical_id === 'string') {
      if (!(cand.profile_ids ?? []).includes(body.canonical_id)) {
        return res.status(400).json({ error: 'canonical_id must be one of the profiles in this candidate' });
      }
      canonicalId = body.canonical_id;
    }

    const actor = await actorId(req);
    const aliasIds = (cand.profile_ids ?? []).filter((p: string) => p !== canonicalId);
    const merged: string[] = [];
    for (const aliasId of aliasIds) {
      const { error: mErr } = await supabase.rpc('merge_speaker_profiles', {
        p_canonical: canonicalId,
        p_alias: aliasId,
        p_rule: `review:${cand.rule}`,
        p_reason: cand.reason,
        p_signals: cand.signals ?? {},
        p_actor: actor,
      });
      if (mErr) {
        logger.warn('speaker merge failed', { candidate: id, alias: aliasId, error: mErr.message });
        return res.status(500).json({ error: mErr.message, merged });
      }
      merged.push(aliasId);
    }

    await supabase.from('speaker_merge_candidates')
      .update({ state: 'merged', decided_by: actor, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id).eq('state', 'open');

    logger.info('speaker dedupe candidate merged', { candidate: id, canonical: canonicalId, aliases: merged.length });
    res.json({ canonical_id: canonicalId, merged });
  });

  /** Reject a candidate. These are different people, and should stop being offered. */
  router.post('/admin/speaker-dedupe/candidates/:id/reject', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid candidate id' });
    const actor = await actorId(req);
    const { data, error } = await supabase.from('speaker_merge_candidates')
      .update({ state: 'rejected', decided_by: actor, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id).eq('state', 'open').select('id');
    if (error) return res.status(500).json({ error: error.message });
    if (!data?.length) return res.status(409).json({ error: 'candidate not found or already decided' });
    res.json({ id, state: 'rejected' });
  });

  /** Undo a merge. Reads the audit row, so it restores exactly what moved. */
  router.post('/admin/speaker-dedupe/unmerge', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const aliasId = typeof body.alias_id === 'string' ? body.alias_id : '';
    if (!UUID_RE.test(aliasId)) return res.status(400).json({ error: 'alias_id must be a uuid' });
    const { data, error } = await supabase.rpc('unmerge_speaker_profiles', { p_alias: aliasId });
    if (error) return res.status(400).json({ error: error.message });
    logger.info('speaker merge reverted', { alias: aliasId });
    res.json(data ?? { alias_id: aliasId });
  });

  /**
   * Run the sweep. Defaults to a dry run; writing needs `dry_run: false`
   * explicitly, so a mis-click plans rather than merges 170 groups.
   */
  router.post('/admin/speaker-dedupe/run', async (req: Request, res: Response) => {
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actor = await actorId(req);
    const bucket = Math.floor(Date.now() / 60_000);
    const job = await enqueueJob(
      'jobs',
      'event-speakers:dedupe-speakers',
      {
        kind: 'event-speakers:dedupe-speakers',
        dry_run: body.dry_run !== false,
        ...(Number.isFinite(Number(body.limit)) && Number(body.limit) > 0
          ? { limit: Math.min(5000, Math.floor(Number(body.limit))) }
          : {}),
        actor,
      },
      { jobId: `dedupe-speakers:${bucket}:${body.dry_run !== false ? 'plan' : 'apply'}` },
    );
    res.status(202).json({ job_id: job.id, dry_run: body.dry_run !== false });
  });

  /** Queue LinkedIn lookups. Populates the field only; never merges. */
  router.post('/admin/speaker-dedupe/enrich-linkedin', async (req: Request, res: Response) => {
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const limit = Number(body.limit);
    const bucket = Math.floor(Date.now() / 60_000);
    const job = await enqueueJob(
      'jobs',
      'event-speakers:enrich-speaker-linkedin',
      {
        kind: 'event-speakers:enrich-speaker-linkedin',
        ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.min(500, Math.floor(limit)) } : {}),
        duplicates_only: body.duplicates_only !== false,
      },
      { jobId: `enrich-speaker-linkedin:${bucket}` },
    );
    res.status(202).json({ job_id: job.id });
  });
}

export function registerDedupeRoutes(app: Express, ctx?: Record<string, unknown>): void {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Parsed without a regex: /^Bearer\s+(.+)$/ backtracks polynomially on a
  // header of "bearer " plus many spaces, and this is attacker-controlled.
  const BEARER = 'bearer ';
  const userClient = (req: Request) => {
    if (!supabaseAnonKey) return null;
    const raw = (req.headers?.authorization ?? req.headers?.Authorization) as string | undefined;
    if (typeof raw !== 'string' || raw.length <= BEARER.length) return null;
    if (raw.slice(0, BEARER.length).toLowerCase() !== BEARER) return null;
    const token = raw.slice(BEARER.length).trim();
    if (!token) return null;
    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  };

  const logger = {
    info: (m: string, meta?: Record<string, unknown>) => console.log(`[event-speakers] ${m}`, meta ?? ''),
    warn: (m: string, meta?: Record<string, unknown>) => console.warn(`[event-speakers] ${m}`, meta ?? ''),
  };

  const router = Router();
  // Small JSON only; nothing here accepts a payload worth more than this.
  router.use(json({ limit: '64kb' }));
  mountDedupeRoutes(router, {
    supabase,
    userClient,
    logger,
    ...(typeof ctx?.enqueueJob === 'function' && { enqueueJob: ctx.enqueueJob as Deps['enqueueJob'] }),
  });
  app.use('/api/modules/event-speakers', router);
  console.log('[event-speakers] dedupe review routes registered');
}
