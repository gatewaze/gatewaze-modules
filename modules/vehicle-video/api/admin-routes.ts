// @ts-nocheck — express + supabase-js resolved at module-host install time.

/**
 * Admin routes for the Vehicle Video module (spec §9). Mounted under
 * /api/modules/vehicle-video (the platform JWT middleware runs first).
 *
 *   GET    /inventory                 — retailer's live Auto Trader stock (cached, stale-safe)
 *   POST   /inventory/refresh         — force-refresh the stock cache
 *   POST   /runs                      — create from listing_id | source_url | upload
 *   POST   /runs/:id/photos           — attach photos (base64 chunks; final=true → Phase A)
 *   GET    /runs                      — list (summary)
 *   GET    /runs/:id                  — run + shots
 *   PATCH  /runs/:id/style            — override market / template / knobs (pre-approval)
 *   PATCH  /runs/:id/shots            — edit narration/camera, keep/drop (pre-approval)
 *   POST   /runs/:id/rescript         — re-run style + script
 *   POST   /runs/:id/approve-plan     — GATE 1 (atomic) → enqueue per-kept-shot clips
 *   POST   /shots/:id/approve         — GATE 2 approve one clip
 *   POST   /shots/:id/regenerate      — reject + re-enqueue one clip (opt. next alt image)
 *   POST   /runs/:id/finalize         — atomic → enqueue finalize
 *   DELETE /runs/:id                  — delete run + storage
 */

import type { Request, Response, Router } from 'express';
import { fetchRetailerStock } from '../lib/autotrader.js';
import { PROMO_THEMES, FALLBACK_CONTENT } from '../lib/promo-themes.js';
import { removeRun } from '../lib/storage.js';
import { resolveVideoConfig, mergeOverrides } from '../lib/style.js';
import { VehicleVideoError, apiErrorBody } from '../lib/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminDeps {
  supabase: { from(table: string): any; storage: any };
  logger: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void };
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

// In-memory inventory cache (spec §5: stock is not persisted; short cache).
interface StockCache { fetchedAt: number; vehicles: unknown[] }
const stockCache = new Map<string, StockCache>();
const STOCK_TTL_MS = 10 * 60_000;

// Module config lives in installed_modules.config (the platform convention — the
// admin Feature-Access config UI writes there), with a process.env fallback.
let cfgCache: { at: number; cfg: Record<string, string> } | null = null;
async function moduleConfig(supabase: AdminDeps['supabase']): Promise<Record<string, string>> {
  if (cfgCache && Date.now() - cfgCache.at < 30_000) return cfgCache.cfg;
  let cfg: Record<string, string> = {};
  try {
    const { data } = await supabase.from('installed_modules').select('config').eq('id', 'vehicle-video').maybeSingle();
    if (data?.config && typeof data.config === 'object') cfg = data.config as Record<string, string>;
  } catch { /* fall back to env */ }
  cfgCache = { at: Date.now(), cfg };
  return cfg;
}
async function cfgValue(supabase: AdminDeps['supabase'], key: string): Promise<string | null> {
  const cfg = await moduleConfig(supabase);
  const v = cfg[key] ?? process.env[key];
  return v != null && String(v).trim() ? String(v).trim() : null;
}

function sendErr(res: Response, err: unknown): void {
  const status = err instanceof VehicleVideoError ? err.httpStatus : 500;
  res.status(status).json(apiErrorBody(err));
}

export function mountAdminRoutes(router: Router, deps: AdminDeps): void {
  const { supabase, logger, enqueueJob } = deps;

  // ── inventory ──────────────────────────────────────────────────────────────
  router.get('/inventory', async (_req: Request, res: Response) => {
    const rid = await cfgValue(supabase, 'VEHICLE_VIDEO_AUTOTRADER_RETAILER_ID');
    if (!rid) return res.status(409).json({ error: { code: 'BAD_REQUEST', message: 'VEHICLE_VIDEO_AUTOTRADER_RETAILER_ID not configured' } });
    const cached = stockCache.get(rid);
    const fresh = cached && Date.now() - cached.fetchedAt < STOCK_TTL_MS;
    if (fresh) {
      return res.json({ fetched_at: new Date(cached.fetchedAt).toISOString(), stale: false, vehicles: cached.vehicles });
    }
    try {
      const vehicles = await fetchRetailerStock(rid, 'inventory');
      stockCache.set(rid, { fetchedAt: Date.now(), vehicles });
      res.json({ fetched_at: new Date().toISOString(), stale: false, vehicles });
    } catch (err) {
      logger.warn('inventory fetch failed', { message: (err as Error).message });
      if (cached) {
        return res.json({ fetched_at: new Date(cached.fetchedAt).toISOString(), stale: true, vehicles: cached.vehicles });
      }
      res.status(502).json({ error: { code: 'INVENTORY_FETCH_FAILED', message: 'Auto Trader stock fetch failed and no cache is available' } });
    }
  });

  router.post('/inventory/refresh', async (_req: Request, res: Response) => {
    const rid = await cfgValue(supabase, 'VEHICLE_VIDEO_AUTOTRADER_RETAILER_ID');
    if (rid) stockCache.delete(rid);
    cfgCache = null;
    res.status(202).json({});
  });

  // ── branding / watermark (module-level: a dealer's logo is the same for all) ──
  router.get('/branding', async (_req: Request, res: Response) => {
    const { resolveWatermark } = await import('../lib/watermark.js');
    const wm = await resolveWatermark(supabase);
    const logo_url = wm.logo_path
      ? `${(process.env.SUPABASE_PUBLIC_URL ?? process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')}/storage/v1/object/public/${process.env.HOST_MEDIA_BUCKET ?? 'media'}/${wm.logo_path}`
      : null;
    res.json({ watermark: wm, logo_url });
  });

  // Upload a logo (base64). Preserves transparency (PNG). Enables the watermark.
  router.post('/branding/logo', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { base64?: string };
    if (!b.base64) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'base64 logo required' } });
    try {
      const { normaliseLogo } = await import('../lib/images.js');
      const { saveWatermark } = await import('../lib/watermark.js');
      const png = await normaliseLogo(Buffer.from(b.base64, 'base64'));
      const path = `vehicle-video/_brand/logo-${Date.now()}.png`;
      const { error } = await supabase.storage.from(process.env.HOST_MEDIA_BUCKET ?? 'media').upload(path, png, { contentType: 'image/png', upsert: true });
      if (error) throw new Error(error.message);
      const wm = await saveWatermark(supabase, { logo_path: path, enabled: true });
      res.json({ watermark: wm });
    } catch (err) {
      sendErr(res, err);
    }
  });

  // Auto-pull the dealer logo from their Auto Trader retailer page.
  router.post('/branding/logo/autopull', async (_req: Request, res: Response) => {
    const rid = await cfgValue(supabase, 'VEHICLE_VIDEO_AUTOTRADER_RETAILER_ID');
    if (!rid) return res.status(409).json({ error: { code: 'BAD_REQUEST', message: 'no retailerId configured' } });
    try {
      const { fetchRetailerLogo } = await import('../lib/autotrader.js');
      const { normaliseLogo } = await import('../lib/images.js');
      const { saveWatermark } = await import('../lib/watermark.js');
      const url = await fetchRetailerLogo(rid, 'branding');
      if (!url) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'could not find a logo on the retailer page — upload one instead' } });
      const dl = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!dl.ok) throw new Error(`logo download HTTP ${dl.status}`);
      const png = await normaliseLogo(Buffer.from(await dl.arrayBuffer()));
      const path = `vehicle-video/_brand/logo-${Date.now()}.png`;
      const { error } = await supabase.storage.from(process.env.HOST_MEDIA_BUCKET ?? 'media').upload(path, png, { contentType: 'image/png', upsert: true });
      if (error) throw new Error(error.message);
      const wm = await saveWatermark(supabase, { logo_path: path, enabled: true });
      res.json({ watermark: wm, source_url: url });
    } catch (err) {
      sendErr(res, err);
    }
  });

  // Update watermark settings (enabled / position / scale / opacity).
  router.put('/branding', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { saveWatermark } = await import('../lib/watermark.js');
    const patch: Record<string, unknown> = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(b.position as string)) patch.position = b.position;
    if (typeof b.scale === 'number') patch.scale = Math.min(0.3, Math.max(0.05, b.scale));
    if (typeof b.opacity === 'number') patch.opacity = Math.min(1, Math.max(0, b.opacity));
    const wm = await saveWatermark(supabase, patch);
    res.json({ watermark: wm });
  });

  // ── promo themes ─────────────────────────────────────────────────────────────
  // List the available promo styles (Getaway/Police, F1 Showdown, Top-Gear Drive…).
  router.get('/themes', (_req: Request, res: Response) => {
    res.json({
      themes: PROMO_THEMES.map((t) => ({
        id: t.id, title: t.title, description: t.description, best_for: t.bestFor ?? null,
        shots: t.shots.length, title_card: FALLBACK_CONTENT[t.id]?.titleCard ?? null,
      })),
    });
  });

  // Generate a promo for a run in the chosen theme (async → generate-promo worker).
  router.post('/runs/:id/promo', async (req: Request, res: Response) => {
    if (!enqueueJob) return res.status(503).json({ error: { code: 'INTERNAL', message: 'job queue unavailable' } });
    const id = req.params.id;
    const themeId = typeof (req.body ?? {}).theme_id === 'string' ? (req.body as any).theme_id : '';
    if (!PROMO_THEMES.some((t) => t.id === themeId)) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'unknown or missing theme_id' } });
    }
    const { data: run } = await supabase.from('vehicle_videos').select('id').eq('id', id).single();
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'run not found' } });
    await supabase.from('vehicle_videos').update({ video_status: 'clips_in_progress', error: null }).eq('id', id);
    await enqueueJob('jobs', 'vehicle-video:generate-promo', { runId: id, themeId });
    res.status(202).json({ id, theme_id: themeId, video_status: 'clips_in_progress' });
  });

  // ── runs ───────────────────────────────────────────────────────────────────
  router.post('/runs', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body.input_mode === 'upload' ? 'upload' : 'url';
    const market = typeof body.market === 'string' && body.market.trim() ? body.market.trim() : null;

    if (mode === 'upload') {
      const ins = await supabase.from('vehicle_videos')
        .insert({ input_mode: 'upload', market, script_status: 'pending' }).select('*').single();
      if (ins.error) return res.status(500).json({ error: { code: 'INTERNAL', message: ins.error.message } });
      return res.status(201).json({ id: ins.data.id, script_status: 'pending' });
    }

    // URL mode: accept listing_id or a car-details source_url.
    let sourceUrl: string | null = null;
    if (typeof body.listing_id === 'string' && /^\d{6,}$/.test(body.listing_id)) {
      sourceUrl = `https://www.autotrader.co.uk/car-details/${body.listing_id}`;
    } else if (typeof body.source_url === 'string' && /autotrader\.co\.uk\/car-details\/\d{6,}/.test(body.source_url)) {
      sourceUrl = body.source_url;
    }
    if (!sourceUrl) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'provide a listing_id or an Auto Trader car-details source_url' } });
    }
    const ins = await supabase.from('vehicle_videos')
      .insert({ input_mode: 'url', source_url: sourceUrl, market, script_status: 'scraping' }).select('*').single();
    if (ins.error) return res.status(500).json({ error: { code: 'INTERNAL', message: ins.error.message } });
    if (enqueueJob) await enqueueJob('jobs', 'vehicle-video:scrape-and-script', { runId: ins.data.id });
    res.status(201).json({ id: ins.data.id, script_status: 'scraping' });
  });

  // Photos: base64 chunks (upload mode). `final:true` closes upload → Phase A.
  router.post('/runs/:id/photos', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    const { data: run } = await supabase.from('vehicle_videos').select('id, input_mode, script_status, photo_paths').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    if (run.input_mode !== 'upload' || !['pending', 'uploading'].includes(run.script_status)) {
      return res.status(409).json({ error: { code: 'BAD_REQUEST', message: 'run not accepting uploads' } });
    }
    const body = (req.body ?? {}) as { photos?: Array<{ filename?: string; base64: string }>; final?: boolean };
    const maxUploads = Number(process.env.VEHICLE_VIDEO_MAX_UPLOADS ?? 60);
    const existing: string[] = run.photo_paths ?? [];
    const photos = Array.isArray(body.photos) ? body.photos : [];
    if (existing.length + photos.length > maxUploads) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: `too many photos (max ${maxUploads})` } });
    }

    const { normalise } = await import('../lib/images.js');
    const { runPrefix } = await import('../lib/storage.js');
    const paths = [...existing];
    for (const p of photos) {
      try {
        const raw = Buffer.from(p.base64, 'base64');
        if (!raw.length) continue;
        const norm = await normalise(raw);
        const path = `${runPrefix(id)}/photos/${String(paths.length).padStart(2, '0')}.jpg`;
        const { error } = await supabase.storage.from(process.env.HOST_MEDIA_BUCKET ?? 'media')
          .upload(path, norm.buffer, { contentType: 'image/jpeg', upsert: true });
        if (!error) paths.push(path);
      } catch { /* skip bad image */ }
    }

    const finalCall = body.final === true;
    const next = finalCall ? 'scraping' : 'uploading';
    await supabase.from('vehicle_videos').update({ photo_paths: paths, script_status: next }).eq('id', id);
    if (finalCall && enqueueJob) await enqueueJob('jobs', 'vehicle-video:scrape-and-script', { runId: id });
    res.json({ id, photo_paths: paths, script_status: next });
  });

  router.get('/runs', async (_req: Request, res: Response) => {
    const { data, error } = await supabase.from('vehicle_videos')
      .select('id, vehicle, market, script_status, video_status, cost_micro_usd, video_path, created_at')
      .order('created_at', { ascending: false }).limit(100);
    if (error) return res.status(500).json({ error: { code: 'INTERNAL', message: error.message } });
    res.json({ runs: data ?? [] });
  });

  router.get('/runs/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    const { data: run } = await supabase.from('vehicle_videos').select('*').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    const { data: shots } = await supabase.from('vehicle_video_shots').select('*').eq('vehicle_video_id', id).order('seq');
    res.json({ run, shots: shots ?? [] });
  });

  router.patch('/runs/:id/style', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    const { data: run } = await supabase.from('vehicle_videos').select('*').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    if (run.script_status !== 'ready_for_review') {
      return res.status(409).json({ error: { code: 'GATE_CLOSED', message: 'style is only editable while ready_for_review' } });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const merged = mergeOverrides(run.style_profile ?? { vehicle_character: 'executive', audience: {}, style: {} }, {
      vehicle_character: body.vehicle_character as any,
      style: (body.style as any) ?? undefined,
    });
    const patch: Record<string, unknown> = { style_profile: merged };
    if (typeof body.market === 'string') patch.market = body.market.trim();
    const upd = await supabase.from('vehicle_videos').update(patch).eq('id', id).select('*').single();
    if (upd.error) return res.status(500).json({ error: { code: 'INTERNAL', message: upd.error.message } });
    res.json({ run: upd.data });
  });

  router.patch('/runs/:id/shots', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    const { data: run } = await supabase.from('vehicle_videos').select('id, script_status').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    if (run.script_status !== 'ready_for_review') {
      return res.status(409).json({ error: { code: 'GATE_CLOSED', message: 'shots are only editable while ready_for_review' } });
    }
    const edits = Array.isArray((req.body as any)?.shots) ? (req.body as any).shots : [];
    for (const e of edits) {
      if (!e?.id || !UUID_RE.test(String(e.id))) continue;
      const patch: Record<string, unknown> = {};
      if (typeof e.narration === 'string') patch.narration = e.narration.slice(0, 600);
      if (typeof e.camera_prompt === 'string') patch.camera_prompt = e.camera_prompt.slice(0, 400);
      if (typeof e.kept === 'boolean') patch.kept = e.kept;
      if (Object.keys(patch).length) {
        await supabase.from('vehicle_video_shots').update(patch).eq('id', e.id).eq('vehicle_video_id', id);
      }
    }
    const { data: shots } = await supabase.from('vehicle_video_shots').select('*').eq('vehicle_video_id', id).order('seq');
    const { data: updRun } = await supabase.from('vehicle_videos').select('*').eq('id', id).maybeSingle();
    res.json({ run: updRun, shots: shots ?? [] });
  });

  router.post('/runs/:id/rescript', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    if (!enqueueJob) return res.status(503).json({ error: { code: 'INTERNAL', message: 'job queue unavailable' } });
    const { data: run } = await supabase.from('vehicle_videos').select('id, video_status').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    if (run.video_status !== 'idle') {
      return res.status(409).json({ error: { code: 'GATE_CLOSED', message: 'cannot re-script once clips are running' } });
    }
    await supabase.from('vehicle_videos').update({ script_status: 'styling', error: null }).eq('id', id);
    await enqueueJob('jobs', 'vehicle-video:scrape-and-script', { runId: id });
    res.status(202).json({ id, script_status: 'styling' });
  });

  // Generate ALL remaining clips (batch). Tolerant of the per-shot flow: works
  // while the plan is under review whether or not some clips were already
  // generated individually. Idempotent — only enqueues shots still 'planned'
  // (or 'failed'), so already-generated/in-flight clips are never re-spent.
  router.post('/runs/:id/approve-plan', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    if (!enqueueJob) return res.status(503).json({ error: { code: 'INTERNAL', message: 'job queue unavailable' } });
    const { data: run } = await supabase.from('vehicle_videos').select('*').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    if (!['ready_for_review', 'plan_approved'].includes(run.script_status)) {
      return res.status(409).json({ error: { code: 'GATE_CLOSED', message: `plan not open (script_status=${run.script_status})` } });
    }

    const { data: keptShots } = await supabase.from('vehicle_video_shots')
      .select('id, clip_status').eq('vehicle_video_id', id).eq('kept', true);
    const maxShots = Number(process.env.VEHICLE_VIDEO_MAX_SHOTS ?? 8);
    if (!keptShots?.length) return res.status(422).json({ error: { code: 'BAD_REQUEST', message: 'no kept shots' } });
    if (keptShots.length > maxShots) {
      return res.status(422).json({ error: { code: 'TOO_MANY_SHOTS', message: `kept shots (${keptShots.length}) exceed MAX_SHOTS (${maxShots})` } });
    }
    const toGenerate = keptShots.filter((s: any) => ['planned', 'failed'].includes(s.clip_status));
    if (!toGenerate.length) {
      return res.status(409).json({ error: { code: 'GATE_CLOSED', message: 'all kept shots are already generated or in progress' } });
    }

    // Cost ceiling for the shots we are about to generate.
    const perClip = (process.env.VEHICLE_VIDEO_VEO_MODEL ?? 'fast') === 'standard' ? 3_200_000 : 1_200_000;
    const maxCost = Number(process.env.VEHICLE_VIDEO_MAX_COST_MICRO_USD);
    if (Number.isFinite(maxCost) && maxCost > 0 && (run.cost_micro_usd ?? 0) + perClip * toGenerate.length > maxCost) {
      return res.status(422).json({ error: { code: 'COST_CEILING_EXCEEDED', message: 'generating all remaining clips would exceed the per-run cost ceiling' } });
    }

    // Snapshot the video config on first spend; move into clips_in_progress.
    const patch: Record<string, unknown> = { video_status: 'clips_in_progress' };
    if (!run.video_config || Object.keys(run.video_config).length === 0) {
      patch.video_config = resolveVideoConfig(run.style_profile ?? { vehicle_character: 'executive', audience: {}, style: { pacing: 'balanced', camera_energy: 'moderate', tone: 'confident', voice: 'Kore' } });
      patch.plan_approved_at = new Date().toISOString();
      patch.approved_by = (req as any).user?.id ?? (req as any).auth?.userId ?? null;
    }
    await supabase.from('vehicle_videos').update(patch).eq('id', id);
    for (const s of toGenerate) await enqueueJob('jobs', 'vehicle-video:generate-clip', { runId: id, shotId: s.id });
    res.status(202).json({ id, video_status: 'clips_in_progress', generating: toGenerate.length });
  });

  // Generate ONE shot's clip on demand (preview before committing to the whole set).
  // Works while the plan is under review — spends Veo for just this shot so the
  // operator can check it looks/sounds right first.
  router.post('/shots/:id/generate', async (req: Request, res: Response) => {
    const shotId = String(req.params.id);
    if (!UUID_RE.test(shotId)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    if (!enqueueJob) return res.status(503).json({ error: { code: 'INTERNAL', message: 'job queue unavailable' } });
    const { data: shot } = await supabase.from('vehicle_video_shots').select('*').eq('id', shotId).maybeSingle();
    if (!shot) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    if (!shot.kept) return res.status(409).json({ error: { code: 'BAD_REQUEST', message: 'shot is dropped' } });
    const { data: run } = await supabase.from('vehicle_videos').select('*').eq('id', shot.vehicle_video_id).maybeSingle();
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'run not found' } });

    // Cost ceiling.
    const perClip = (process.env.VEHICLE_VIDEO_VEO_MODEL ?? 'fast') === 'standard' ? 3_200_000 : 1_200_000;
    const maxCost = Number(process.env.VEHICLE_VIDEO_MAX_COST_MICRO_USD);
    if (Number.isFinite(maxCost) && maxCost > 0 && (run.cost_micro_usd ?? 0) + perClip > maxCost) {
      return res.status(422).json({ error: { code: 'COST_CEILING_EXCEEDED', message: 'per-run Veo cost ceiling would be exceeded' } });
    }

    // Snapshot the video config from the current style on first generation, and
    // move the run into clips_in_progress (editing the plan stays allowed while
    // script_status is still ready_for_review).
    const patch: Record<string, unknown> = {};
    if (!run.video_config || Object.keys(run.video_config).length === 0) {
      patch.video_config = resolveVideoConfig(run.style_profile ?? { vehicle_character: 'executive', audience: {}, style: { pacing: 'balanced', camera_energy: 'moderate', tone: 'confident', voice: 'Kore' } });
    }
    if (run.video_status === 'idle') patch.video_status = 'clips_in_progress';
    if (Object.keys(patch).length) await supabase.from('vehicle_videos').update(patch).eq('id', run.id);

    await supabase.from('vehicle_video_shots').update({ clip_status: 'planned', approval_status: 'pending', error: null }).eq('id', shotId);
    await enqueueJob('jobs', 'vehicle-video:generate-clip', { runId: run.id, shotId });
    res.status(202).json({ id: shotId, status: 'generating' });
  });

  // GATE 2 — approve one clip; when all kept shots approved → ready_to_finalize.
  router.post('/shots/:id/approve', async (req: Request, res: Response) => {
    const shotId = String(req.params.id);
    if (!UUID_RE.test(shotId)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    const { data: shot } = await supabase.from('vehicle_video_shots').select('*').eq('id', shotId).maybeSingle();
    if (!shot) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    if (shot.clip_status !== 'generated') {
      return res.status(409).json({ error: { code: 'BAD_REQUEST', message: 'clip not generated yet' } });
    }
    const upd = await supabase.from('vehicle_video_shots').update({ approval_status: 'approved' }).eq('id', shotId).select('*').single();
    if (upd.error) return res.status(500).json({ error: { code: 'INTERNAL', message: upd.error.message } });

    // If every kept shot is approved, flip the run to ready_to_finalize.
    const runId = shot.vehicle_video_id;
    const { data: pending } = await supabase.from('vehicle_video_shots')
      .select('id').eq('vehicle_video_id', runId).eq('kept', true).neq('approval_status', 'approved');
    if (!pending?.length) {
      await supabase.from('vehicle_videos').update({ video_status: 'ready_to_finalize' }).eq('id', runId).eq('video_status', 'clips_in_progress');
    }
    res.json({ shot: upd.data });
  });

  router.post('/shots/:id/regenerate', async (req: Request, res: Response) => {
    const shotId = String(req.params.id);
    if (!UUID_RE.test(shotId)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    if (!enqueueJob) return res.status(503).json({ error: { code: 'INTERNAL', message: 'job queue unavailable' } });
    const { data: shot } = await supabase.from('vehicle_video_shots').select('*').eq('id', shotId).maybeSingle();
    if (!shot) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    const maxRegens = Number(process.env.VEHICLE_VIDEO_MAX_REGENS ?? 3);
    if ((shot.regen_count ?? 0) >= maxRegens) {
      return res.status(422).json({ error: { code: 'REGEN_LIMIT_REACHED', message: `regen limit (${maxRegens}) reached` } });
    }
    const useAlt = (req.body as any)?.use_alt === true && (shot.alt_photo_paths?.length ?? 0) > 0;
    const patch: Record<string, unknown> = {
      approval_status: 'rejected', clip_status: 'planned', veo_operation: null, clip_path: null,
      regen_count: (shot.regen_count ?? 0) + 1,
    };
    if (useAlt) patch.current_alt_index = (shot.current_alt_index ?? 0) + 1;
    const upd = await supabase.from('vehicle_video_shots').update(patch).eq('id', shotId).select('*').single();
    if (upd.error) return res.status(500).json({ error: { code: 'INTERNAL', message: upd.error.message } });
    await enqueueJob('jobs', 'vehicle-video:generate-clip', { runId: shot.vehicle_video_id, shotId });
    res.status(202).json({ shot: upd.data });
  });

  // Free (no-Veo) whole-video motion preview — Ken Burns over the photos + voiceover.
  router.post('/runs/:id/preview', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    if (!enqueueJob) return res.status(503).json({ error: { code: 'INTERNAL', message: 'job queue unavailable' } });
    const { data: run } = await supabase.from('vehicle_videos').select('id, script_status').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
    const { data: kept } = await supabase.from('vehicle_video_shots').select('id').eq('vehicle_video_id', id).eq('kept', true).limit(1);
    if (!kept?.length) return res.status(409).json({ error: { code: 'BAD_REQUEST', message: 'no kept shots to preview yet' } });
    await supabase.from('vehicle_videos').update({ preview_status: 'generating', error: null }).eq('id', id);
    await enqueueJob('jobs', 'vehicle-video:preview', { runId: id });
    res.status(202).json({ id, preview_status: 'generating' });
  });

  // Finalize — atomic: ready_to_finalize → finalizing.
  router.post('/runs/:id/finalize', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    if (!enqueueJob) return res.status(503).json({ error: { code: 'INTERNAL', message: 'job queue unavailable' } });
    const gate = await supabase.from('vehicle_videos')
      .update({ video_status: 'finalizing', error: null })
      .eq('id', id).eq('video_status', 'ready_to_finalize').select('id');
    if (gate.error) return res.status(500).json({ error: { code: 'INTERNAL', message: gate.error.message } });
    if (!gate.data?.length) return res.status(409).json({ error: { code: 'SHOTS_NOT_ALL_APPROVED', message: 'run is not ready to finalize (all kept shots must be approved)' } });
    await enqueueJob('jobs', 'vehicle-video:finalize', { runId: id });
    res.status(202).json({ id, video_status: 'finalizing' });
  });

  router.delete('/runs/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid id' } });
    try { await removeRun(supabase, id); } catch { /* best-effort */ }
    const del = await supabase.from('vehicle_videos').delete().eq('id', id);
    if (del.error) return res.status(500).json({ error: { code: 'INTERNAL', message: del.error.message } });
    res.status(204).end();
  });
}
