// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * Spotify CSV import and connection setup.
 *
 * Mounted under /api/modules/videos-publisher-spotify, which the platform
 * gates to super_admin. There is no OAuth callback here and no public route:
 * nothing in this module authenticates to Spotify, by design.
 */

import { Router, json, type Express, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';

import { parseSpotifyCsv, playDefinitionFor, straddlesDefinitionChange } from '../lib/csv-import.js';
import { serviceClient } from '../lib/service-client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 8MB: a multi-year per-episode-per-day export is large but not unbounded. */
const MAX_CSV_BYTES = 8 * 1024 * 1024;

export function registerRoutes(app: Express, ctx?: Record<string, unknown>): void {
  const supabase = serviceClient();
  const enqueueJob = typeof ctx?.enqueueJob === 'function' ? ctx.enqueueJob : null;
  const log = (m: string, meta?: Record<string, unknown>) =>
    console.log(`[videos-publisher-spotify] ${m}`, meta ?? '');

  const router = Router();
  router.use(rateLimit({
    windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false,
    message: { error: 'rate_limited', message: 'too many requests' },
  }));
  // The CSV arrives as a JSON string field rather than multipart: it keeps
  // the route dependency-free and the files are text.
  router.use(json({ limit: '10mb' }));

  /** The connections, never selecting the sealed column. */
  router.get('/connections', async (_req: Request, res: Response) => {
    const { data, error } = await supabase
      .from('video_platform_connections')
      .select('id, platform, external_account_id, label, state, state_detail, config, collection_enabled, last_collected_at, last_collect_status, last_collect_detail')
      .eq('platform', 'spotify')
      .order('created_at');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ connections: data ?? [] });
  });

  /**
   * Preview a CSV without writing anything.
   *
   * The column schema is documented nowhere, so the first thing an operator
   * needs is to see what we understood before any of it reaches a chart.
   */
  router.post('/csv/preview', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.csv === 'string' ? body.csv : '';
    if (!text) return res.status(400).json({ error: 'csv must be a string' });
    if (text.length > MAX_CSV_BYTES) return res.status(413).json({ error: 'that file is too large' });

    const parsed = parseSpotifyCsv(text);
    res.json({
      rows: parsed.rows.length,
      skipped: parsed.skipped,
      unknown_headings: parsed.unknownHeadings,
      play_definition: parsed.definition,
      straddles_definition_change: straddlesDefinitionChange(parsed.rows),
      sample: parsed.rows.slice(0, 5),
    });
  });

  /**
   * Import a CSV against one connection.
   *
   * Episodes are matched by TITLE, because that is what the export carries.
   * An unmatched row is reported rather than guessed at: attributing a
   * number to the wrong episode is worse than not importing it.
   */
  router.post('/csv/import', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const connectionId = typeof body.connection_id === 'string' ? body.connection_id : '';
    const text = typeof body.csv === 'string' ? body.csv : '';
    if (!UUID_RE.test(connectionId)) return res.status(400).json({ error: 'connection_id must be a uuid' });
    if (!text) return res.status(400).json({ error: 'csv must be a string' });
    if (text.length > MAX_CSV_BYTES) return res.status(413).json({ error: 'that file is too large' });

    const { data: conn } = await supabase
      .from('video_platform_connections')
      .select('id, label').eq('id', connectionId).eq('platform', 'spotify').maybeSingle();
    if (!conn) return res.status(404).json({ error: 'connection not found' });

    const parsed = parseSpotifyCsv(text);
    if (parsed.rows.length === 0) {
      return res.status(400).json({ error: 'nothing readable in that file', unknown_headings: parsed.unknownHeadings });
    }

    // Episode title to publication id, for this connection only.
    const byTitle = new Map<string, string>();
    for (let from = 0; ; from += 500) {
      const { data } = await supabase
        .from('video_publications')
        .select('id, videos!inner(title)')
        .eq('connection_id', connectionId)
        .range(from, from + 499);
      const batch = data ?? [];
      for (const p of batch) {
        const v = Array.isArray(p.videos) ? p.videos[0] : p.videos;
        if (v?.title) byTitle.set(String(v.title).trim().toLowerCase(), p.id);
      }
      if (batch.length < 500) break;
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    const unmatched: string[] = [];
    for (const r of parsed.rows) {
      const publicationId = byTitle.get(r.episodeKey.trim().toLowerCase());
      if (!publicationId) { if (unmatched.length < 25) unmatched.push(r.episodeKey); continue; }
      const day = r.day ?? today;
      rows.push({
        publication_id: publicationId,
        connection_id: connectionId,
        collected_for: day,
        status: 'ok',
        views: r.plays ?? r.downloads ?? null,
        watch_time: r.consumptionTime ?? null,
        raw: {
          source: 'spotify_csv',
          // Which definition this figure was computed under. Without it a
          // backfill across 11 June 2026 shows an unexplainable step.
          play_definition: playDefinitionFor(day),
          plays: r.plays, downloads: r.downloads, listeners: r.listeners,
          followers_gained: r.followersGained, completion_rate: r.completionRate,
        },
        collected_at: new Date().toISOString(),
      });
    }

    if (rows.length === 0) {
      return res.status(422).json({
        error: 'no row in that file matched an episode on this connection',
        unmatched_sample: unmatched,
        hint: 'run discover-episodes first so the catalogue exists',
      });
    }

    const { error } = await supabase
      .from('video_metrics')
      .upsert(rows, { onConflict: 'publication_id,collected_for' });
    if (error) return res.status(500).json({ error: error.message });

    log('csv imported', { connection: conn.label, rows: rows.length, unmatched: unmatched.length });
    res.json({
      imported: rows.length,
      unmatched: parsed.rows.length - rows.length,
      unmatched_sample: unmatched,
      skipped: parsed.skipped,
      unknown_headings: parsed.unknownHeadings,
      straddles_definition_change: straddlesDefinitionChange(parsed.rows),
    });
  });

  /** Kick off a feed discovery or an OP3 collection. */
  for (const [path, job] of [['discover', 'discover-episodes'], ['collect', 'collect-op3']] as const) {
    router.post(`/${path}`, async (req: Request, res: Response) => {
      if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const bucket = Math.floor(Date.now() / 60_000);
      const r = await enqueueJob('jobs', `videos-publisher-spotify:${job}`, {
        kind: `videos-publisher-spotify:${job}`,
        ...(typeof body.connection_id === 'string' && UUID_RE.test(body.connection_id)
          ? { connection_id: body.connection_id } : {}),
      }, { jobId: `${job}:${bucket}` });
      res.status(202).json({ job_id: r.id });
    });
  }

  app.use('/api/modules/videos-publisher-spotify', router);
  console.log('[videos-publisher-spotify] routes registered');
}
