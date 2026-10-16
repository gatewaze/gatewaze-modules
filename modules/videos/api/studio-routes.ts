// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * The studio's API, mounted on the editor router under
 * /api/video-editor/videos/:videoId/studio.
 *
 * Same trust model as the rest of the editor surface: the router has
 * authenticated the caller; each route authorises as the caller against the
 * video itself before the service role touches anything. The selection the
 * editor saves is rebuilt field by field from an allowlist; the row's
 * analysis and outputs are never written from a request.
 */

import type { Request, Response, Router } from 'express';
import { mediaUrl, removeStudioFolder } from '../lib/studio-media.js';
import { clampSelection } from '../lib/artboard.js';
import { falConfigured } from '../lib/fal.js';
import { loadStudioAssets } from '../lib/studio-assets.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A worker that died mid-pass leaves the row in `analysing` or
 * `finalising` for ever, and the routes would refuse to restart it. After
 * this long without a progress write the row is treated as abandoned.
 */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function isStale(row: { state: string; updated_at?: string | null }, now = Date.now()): boolean {
  if (!['analysing', 'finalising', 'queued'].includes(row.state)) return false;
  const t = Date.parse(String(row.updated_at ?? ''));
  return !Number.isFinite(t) || now - t > STALE_AFTER_MS;
}

export interface StudioDeps {
  supabase: { from(t: string): any; storage: any };
  denyUnlessVideo: (req: Request, res: Response, videoId: string) => Promise<boolean>;
  callerId: (req: Request) => Promise<string | null>;
  logger: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void };
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

/** A number from JSON within [lo, hi], or null. */
function num(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}

/**
 * The editor's choices, rebuilt from an allowlist. `duration` bounds the
 * trim; a cut key must name a cut-out the analysis made.
 */
export function sanitiseSelection(body: Record<string, unknown>, analysis: { duration?: number; cuts?: Array<{ key: string }> }): Record<string, unknown> {
  const art = clampSelection({ scale: body.scale, x: body.x, lead: body.lead, emph: body.emph, panels: body.panels });
  const duration = Number(analysis?.duration ?? 0) || 0;
  const keys = new Set((analysis?.cuts ?? []).map((c) => c.key));
  const cut = typeof body.cut === 'string' && keys.has(body.cut) ? body.cut : null;
  let trimIn = num(body.trim_in, 0, Math.max(0, duration));
  let trimOut = num(body.trim_out, 0, Math.max(0, duration));
  if (trimIn != null && trimOut != null && trimOut <= trimIn + 1) { trimIn = null; trimOut = null; }
  const speakers = Array.isArray(body.card_speakers)
    ? body.card_speakers.slice(0, 6).map((s) => ({
      name: String((s as Record<string, unknown>)?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      role: String((s as Record<string, unknown>)?.role ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
      company: String((s as Record<string, unknown>)?.company ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
    })).filter((s) => s.name)
    : null;
  return {
    cut, scale: art.scale, x: art.x, lead: art.lead, emph: art.emph, panels: art.panels,
    trim_in: trimIn, trim_out: trimOut,
    preroll: body.preroll === true,
    card_title: typeof body.card_title === 'string' ? body.card_title.replace(/\s+/g, ' ').trim().slice(0, 200) || null : null,
    card_speakers: speakers,
  };
}

export function mountStudioRoutes(router: Router, deps: StudioDeps): void {
  const { supabase, denyUnlessVideo, callerId, logger, enqueueJob } = deps;

  /** The row with every media path turned into a URL the browser can load. */
  function present(row) {
    const a = row.analysis ?? {};
    const url = (p: unknown) => (typeof p === 'string' && p ? mediaUrl(supabase, p) : null);
    return {
      ...row,
      analysis: {
        ...a,
        cuts: (a.cuts ?? []).map((c) => ({ ...c, url: url(c.path) })),
        panels: (a.panels ?? []).map((p) => ({ ...p, url: url(p.path) })),
        filmstrip: a.filmstrip ? { ...a.filmstrip, url: url(a.filmstrip.path) } : null,
      },
      outputs: { ...(row.outputs ?? {}), thumbnail_url: url(row.outputs?.thumbnail_path) ?? row.outputs?.thumbnail_url ?? null },
      configured: falConfigured(),
    };
  }

  async function readyMaster(videoId: string) {
    const { data } = await supabase
      .from('video_assets').select('id, bytes, filename, duration_seconds, created_at')
      .eq('video_id', videoId).eq('kind', 'master').eq('state', 'ready').limit(1).maybeSingle();
    return data ?? null;
  }

  router.get('/videos/:videoId/studio', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId ?? '');
    if (await denyUnlessVideo(req, res, videoId)) return;
    const { data: row } = await supabase.from('video_studio').select('*').eq('video_id', videoId).maybeSingle();
    const master = await readyMaster(videoId);
    // The brand art goes with the row as data URIs, on request: an <img>
    // cannot carry the bearer token this router requires, and the page
    // asks once rather than on every poll (it is a few hundred KB).
    let brand: Record<string, string> | undefined;
    if (req.query.brand === '1') {
      try {
        const a = await loadStudioAssets();
        brand = { thumbnail_bg: a.thumbnailBg, logo: a.logo, card_bg: a.cardBg };
      } catch (err) {
        logger.warn('studio brand assets unavailable', { error: String((err as Error)?.message ?? err) });
        brand = { thumbnail_bg: '', logo: '', card_bg: '' };
      }
    }
    res.json({ studio: row ? present(row) : null, master, configured: falConfigured(), ...(brand ? { brand } : {}) });
  });

  /** Start, or restart, the analysis of the current ready master. */
  router.post('/videos/:videoId/studio', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId ?? '');
    if (await denyUnlessVideo(req, res, videoId)) return;
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
    if (!falConfigured()) return res.status(503).json({ error: 'the studio needs FAL_API_KEY on the API and worker' });
    const master = await readyMaster(videoId);
    if (!master) return res.status(409).json({ error: 'no ready master for this video yet' });
    const uid = await callerId(req);

    const { data: existing } = await supabase.from('video_studio').select('id, state, updated_at').eq('video_id', videoId).maybeSingle();
    if (existing && ['analysing', 'finalising'].includes(existing.state) && !isStale(existing)) {
      return res.status(409).json({ error: `the studio is already ${existing.state}` });
    }
    // A re-run replaces the working images; the old ones would otherwise
    // sit in the public bucket for ever.
    if (existing) await removeStudioFolder(supabase, videoId, String(existing.id));
    const patch = {
      video_id: videoId, master_asset_id: master.id, state: 'queued', progress: 'Queued', error: null,
      analysis: {}, headlines: [], selection: {}, outputs: {}, requested_by: uid, approved_by: null, approved_at: null,
    };
    const up = existing
      ? await supabase.from('video_studio').update(patch).eq('id', existing.id).select('*').single()
      : await supabase.from('video_studio').insert(patch).select('*').single();
    if (up.error) return res.status(500).json({ error: up.error.message });
    const job = await enqueueJob('jobs', 'videos:studio-analyse', { studio_id: up.data.id }, { jobId: `videos-studio:${up.data.id}:${Date.now()}` });
    logger.info('studio analysis queued', { video: videoId, studio: up.data.id, job: job?.id });
    res.status(202).json({ studio: present(up.data), job_id: job?.id ?? null });
  });

  /** Save the editor's choices. Allowed while ready or approved (a re-approve re-renders). */
  router.patch('/videos/:videoId/studio/selection', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId ?? '');
    if (await denyUnlessVideo(req, res, videoId)) return;
    const { data: row } = await supabase.from('video_studio').select('id, state, analysis').eq('video_id', videoId).maybeSingle();
    if (!row) return res.status(404).json({ error: 'no studio pass for this video' });
    if (!['ready', 'approved'].includes(row.state)) return res.status(409).json({ error: `cannot edit while ${row.state}` });
    const selection = sanitiseSelection((req.body ?? {}) as Record<string, unknown>, row.analysis ?? {});
    const upd = await supabase.from('video_studio').update({ selection }).eq('id', row.id).select('*').single();
    if (upd.error) return res.status(500).json({ error: upd.error.message });
    res.json({ studio: present(upd.data) });
  });

  /** Approve: render the thumbnail, and cut the master if asked. */
  router.post('/videos/:videoId/studio/approve', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId ?? '');
    if (await denyUnlessVideo(req, res, videoId)) return;
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
    const { data: row } = await supabase.from('video_studio').select('id, state, analysis, outputs, master_asset_id, updated_at').eq('video_id', videoId).maybeSingle();
    if (!row) return res.status(404).json({ error: 'no studio pass for this video' });
    // A finalize that died is re-approvable; the editor's choices are intact.
    const resumable = row.state === 'finalising' && isStale(row);
    if (!['ready', 'approved'].includes(row.state) && !resumable) return res.status(409).json({ error: `cannot approve while ${row.state}` });
    // The analysis timeline belongs to the master it was made on. Once a cut
    // master has replaced it, another trim or card would be applied to the
    // already-cut file at the old timings; that needs a fresh analysis.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const wanted = (body.selection && typeof body.selection === 'object') ? (body.selection as Record<string, unknown>) : null;
    if (row.outputs?.master_asset_id && wanted && (wanted.preroll === true || (wanted.trim_in != null && wanted.trim_in !== '') || (wanted.trim_out != null && wanted.trim_out !== ''))) {
      return res.status(409).json({ error: 'the cut and the card are already in the new master; analyse again to trim it further' });
    }
    const master = await readyMaster(videoId);
    if (!master || master.id !== row.master_asset_id) {
      return res.status(409).json({ error: 'the master has changed since the analysis; run the analysis again' });
    }
    // The body may carry the latest selection so one click saves and approves.
    const patch: Record<string, unknown> = { state: 'finalising', progress: 'Queued', error: null, approved_by: await callerId(req) };
    if (wanted) patch.selection = sanitiseSelection(wanted, row.analysis ?? {});
    const upd = await supabase.from('video_studio').update(patch).eq('id', row.id).in('state', resumable ? ['finalising'] : ['ready', 'approved']).select('*').single();
    if (upd.error) return res.status(500).json({ error: upd.error.message });
    const job = await enqueueJob('jobs', 'videos:studio-finalize', { studio_id: row.id }, { jobId: `videos-studio-final:${row.id}:${Date.now()}` });
    logger.info('studio finalize queued', { video: videoId, studio: row.id, job: job?.id });
    res.status(202).json({ studio: present(upd.data), job_id: job?.id ?? null });
  });
}
