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
import { mediaUrl, removeStudioFolder, studioFolder, MEDIA_BUCKET } from '../lib/studio-media.js';
import { clampSelection } from '../lib/artboard.js';
import { falConfigured } from '../lib/fal.js';
import { loadStudioAssets } from '../lib/studio-assets.js';
import { resolveLogo, talkSubject } from '../lib/studio-logo.js';
import { uploadSpec, prunePending, maxBytesFor, type PendingUpload } from '../lib/studio-uploads.js';
import { supabaseStore } from '../lib/storage.js';

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
export function sanitiseSelection(body: Record<string, unknown>, analysis: { duration?: number; cuts?: Array<{ key: string }>; panels?: Array<{ key: string }> }): Record<string, unknown> {
  const art = clampSelection({ scale: body.scale, x: body.x, y: body.y as never, lead: body.lead, emph: body.emph, panels: body.panels });
  const duration = Number(analysis?.duration ?? 0) || 0;
  const keys = new Set((analysis?.cuts ?? []).map((c) => c.key));
  const cut = typeof body.cut === 'string' && keys.has(body.cut) ? body.cut : null;
  const panelKeys = new Set((analysis?.panels ?? []).map((p) => p.key));
  const panel_keys = Array.isArray(body.panel_keys)
    ? [...new Set(body.panel_keys.filter((k): k is string => typeof k === 'string' && panelKeys.has(k)))].slice(0, 2)
    : null;
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
    cut, scale: art.scale, x: art.x, y: art.y, lead: art.lead, emph: art.emph, panels: art.panels, panel_keys,
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
    const logo = await resolveLogo(supabase, videoId, row?.analysis?.context ?? null);
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
    res.json({
      studio: row ? present(row) : null, master, configured: falConfigured(),
      logo: { url: logo.url, source: logo.source, company: logo.company, can_upload: Boolean(logo.subject) },
      ...(brand ? { brand } : {}),
    });
  });

  // ── Uploads: a logo for the talk, a speaker photo, a background image ───
  //
  // Same shape as a master upload, smaller: mint a signed URL into the
  // public media bucket, the browser PUTs, complete checks the object and
  // records it. The studio row remembers what it minted so complete only
  // accepts a path this row asked for.

  router.post('/videos/:videoId/studio/uploads/mint', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId ?? '');
    if (await denyUnlessVideo(req, res, videoId)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const spec = uploadSpec(body.kind, body.mime_type, body.bytes);
    if (!spec.ok) return res.status(400).json({ error: spec.error });
    const { data: row } = await supabase.from('video_studio').select('id, pending_uploads').eq('video_id', videoId).maybeSingle();
    if (!row) return res.status(404).json({ error: 'analyse the video first' });
    let path: string;
    if (spec.spec.kind === 'logo') {
      const subject = await talkSubject(supabase, videoId);
      if (!subject) return res.status(409).json({ error: 'the video is not attached to a talk, so there is nothing to store a logo against' });
      path = `video-studio/logos/${subject.type}/${subject.id}/logo-${Date.now()}.${spec.spec.ext}`;
    } else {
      path = `${studioFolder(videoId, String(row.id))}/upload-${spec.spec.kind}-${Date.now()}.${spec.spec.ext}`;
    }
    const uid = await callerId(req);
    const pending: PendingUpload[] = [...prunePending(row.pending_uploads), { path, kind: spec.spec.kind, mime: spec.spec.mime, bytes: spec.spec.bytes, by: uid, at: new Date().toISOString() }].slice(-10);
    try {
      const url = await supabaseStore(supabase, MEDIA_BUCKET).signUpload(path, spec.spec.mime, 2 * 3600, spec.spec.bytes);
      await supabase.from('video_studio').update({ pending_uploads: pending }).eq('id', row.id);
      res.json({ path, upload_url: url, upload_headers: { 'Content-Type': spec.spec.mime } });
    } catch (err) {
      logger.warn('could not sign a studio upload', { video: videoId, error: String((err as Error)?.message ?? err) });
      res.status(500).json({ error: 'could not sign the upload' });
    }
  });

  router.post('/videos/:videoId/studio/uploads/complete', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId ?? '');
    if (await denyUnlessVideo(req, res, videoId)) return;
    const path = String(((req.body ?? {}) as Record<string, unknown>).path ?? '');
    const { data: row } = await supabase.from('video_studio').select('id, state, analysis, selection, pending_uploads').eq('video_id', videoId).maybeSingle();
    if (!row) return res.status(404).json({ error: 'no studio pass for this video' });
    const pending = prunePending(row.pending_uploads);
    const entry = pending.find((p) => p.path === path);
    if (!entry) return res.status(400).json({ error: 'that upload was not minted for this video, or has expired' });
    const uid = await callerId(req);
    if (entry.by && uid !== entry.by) return res.status(403).json({ error: 'this upload was not minted by you' });

    const store = supabaseStore(supabase, MEDIA_BUCKET);
    const head = await store.head(path);
    if (!head.ok) return res.status(409).json({ error: 'nothing has arrived in storage yet' });
    const rest = pending.filter((p) => p.path !== path);
    if (head.bytes > maxBytesFor(entry.kind) * 1.1 || !head.contentType || head.contentType.toLowerCase() !== entry.mime) {
      await store.remove(path);
      await supabase.from('video_studio').update({ pending_uploads: rest }).eq('id', row.id);
      return res.status(415).json({ error: 'the stored file is not the type or size that was declared' });
    }

    if (entry.kind === 'logo') {
      const subject = await talkSubject(supabase, videoId);
      if (!subject) return res.status(409).json({ error: 'the video is not attached to a talk' });
      const up = await supabase.from('video_talk_logos').upsert({
        subject_type: subject.type, subject_id: subject.id, storage_bucket: MEDIA_BUCKET, storage_path: path,
        filename: path.split('/').pop(), mime_type: entry.mime, bytes: head.bytes, uploaded_by: uid,
      }, { onConflict: 'subject_type,subject_id' });
      if (up.error) return res.status(500).json({ error: up.error.message });
      await supabase.from('video_studio').update({ pending_uploads: rest }).eq('id', row.id);
      logger.info('talk logo uploaded', { video: videoId, subject: subject.id });
      return res.json({ logo: { url: mediaUrl(supabase, path), source: 'talk' } });
    }

    if (entry.kind === 'background') {
      const key = `panel-upload-${Date.now()}`;
      const a = row.analysis ?? {};
      const panels = [{ key, t: null, path, note: 'uploaded image', composite: false, source: 'upload' }, ...(a.panels ?? [])];
      const selPanels = Array.isArray(row.selection?.panel_keys) ? row.selection.panel_keys : (a.panels ?? []).slice(0, 2).map((p) => p.key);
      const selection = { ...(row.selection ?? {}), panels: true, panel_keys: [key, ...selPanels.filter((k) => k !== key)].slice(0, 2) };
      const upd = await supabase.from('video_studio').update({ analysis: { ...a, panels }, selection, pending_uploads: rest }).eq('id', row.id).select('*').single();
      if (upd.error) return res.status(500).json({ error: upd.error.message });
      return res.json({ studio: present(upd.data) });
    }

    // A speaker photo: the worker cuts it out and adds it as a frame.
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
    if (!['ready', 'approved'].includes(row.state)) return res.status(409).json({ error: `cannot add a photo while ${row.state}` });
    const upd = await supabase.from('video_studio').update({ pending_uploads: rest, progress: 'Cutting out the uploaded photo', error: null }).eq('id', row.id).select('*').single();
    if (upd.error) return res.status(500).json({ error: upd.error.message });
    await enqueueJob('jobs', 'videos:studio-upload', { studio_id: row.id, path }, { jobId: `videos-studio-upload-${row.id}-${Date.now()}` });
    res.status(202).json({ studio: present(upd.data) });
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
    // No ':' in a custom job id: BullMQ refuses it on the worker side.
    const job = await enqueueJob('jobs', 'videos:studio-analyse', { studio_id: up.data.id }, { jobId: `videos-studio-${up.data.id}-${Date.now()}` });
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
    const job = await enqueueJob('jobs', 'videos:studio-finalize', { studio_id: row.id }, { jobId: `videos-studio-final-${row.id}-${Date.now()}` });
    logger.info('studio finalize queued', { video: videoId, studio: row.id, job: job?.id });
    res.status(202).json({ studio: present(upd.data), job_id: job?.id ?? null });
  });
}
