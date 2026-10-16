// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos:studio-analyse — run the studio's analysis pass over one video's
 * ready master and store what it found on the video_studio row.
 *
 * Job data: { studio_id }. The row says which video and which master. The
 * handler claims the row by moving it from queued to analysing, so a job
 * replayed after a crash does not run twice over a pass that finished.
 */

import { analyseMaster, DEFAULT_MAX_MASTER_BYTES } from '../lib/studio-analyse.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function studioConfig(supabase): Promise<{ maxMasterBytes: number; sampleEvery: number }> {
  try {
    const { data } = await supabase.from('installed_modules').select('config').eq('id', 'videos').maybeSingle();
    const cfg = data?.config ?? {};
    const max = Number(cfg.studio_max_master_bytes);
    const every = Number(cfg.studio_sample_every_seconds);
    return {
      maxMasterBytes: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_MASTER_BYTES,
      sampleEvery: Number.isFinite(every) && every >= 2 && every <= 120 ? every : 10,
    };
  } catch {
    return { maxMasterBytes: DEFAULT_MAX_MASTER_BYTES, sampleEvery: 10 };
  }
}

export default async function studioAnalyseHandler(job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos:studio] ${m}`);
  const studioId = String(job?.data?.studio_id ?? '');
  if (!UUID_RE.test(studioId)) { log('no studio_id'); return; }

  // Claim.
  const { data: row, error } = await supabase
    .from('video_studio').update({ state: 'analysing', progress: 'Starting', error: null })
    .eq('id', studioId).eq('state', 'queued').select('id, video_id, master_asset_id').maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) { log(`${studioId}: not queued, nothing to do`); return; }

  const { data: asset } = await supabase
    .from('video_assets').select('id, storage_provider, storage_bucket, storage_path, bytes, state')
    .eq('id', row.master_asset_id ?? '00000000-0000-0000-0000-000000000000').maybeSingle();
  const progress = async (line: string) => { await supabase.from('video_studio').update({ progress: line }).eq('id', studioId); };
  try {
    if (!asset || asset.state !== 'ready') throw new Error('the master is not ready');
    const cfg = await studioConfig(supabase);
    const { analysis, headlines } = await analyseMaster(supabase, {
      studioId, videoId: String(row.video_id), asset, maxMasterBytes: cfg.maxMasterBytes, sampleEvery: cfg.sampleEvery, progress, log,
    });
    const first = headlines[0] ?? { lead: '', emph: '' };
    const upd = await supabase.from('video_studio').update({
      state: 'ready', progress: null, error: null, analysis, headlines,
      selection: {
        cut: analysis.cuts[0]?.key ?? null, scale: 1, x: 0.62, lead: first.lead, emph: first.emph, panels: true,
        trim_in: null, trim_out: null, preroll: false, card_title: analysis.context?.title ?? null, card_speakers: null,
      },
    }).eq('id', studioId);
    if (upd.error) throw new Error(upd.error.message);
    log(`${studioId}: ready, ${analysis.cuts.length} cut-outs, ${analysis.panels.length} panels, ${analysis.model_calls} model calls`);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    log(`${studioId}: failed: ${msg}`);
    await supabase.from('video_studio').update({ state: 'failed', progress: null, error: msg }).eq('id', studioId);
  }
}
