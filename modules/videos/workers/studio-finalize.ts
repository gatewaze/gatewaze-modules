// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos:studio-finalize — produce what the editor approved: the thumbnail
 * and, if asked, the trimmed master with the talk card in front.
 *
 * Job data: { studio_id }. Claims the row from finalising-requested state
 * ('finalising' is set by the API at approve time; this handler only runs
 * while it holds that state and the outputs are empty).
 */

import { finalizeStudio } from '../lib/studio-finalize.js';
import { DEFAULT_MAX_MASTER_BYTES } from '../lib/studio-analyse.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function studioFinalizeHandler(job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos:studio] ${m}`);
  const studioId = String(job?.data?.studio_id ?? '');
  if (!UUID_RE.test(studioId)) { log('no studio_id'); return; }

  const { data: row } = await supabase
    .from('video_studio').select('id, video_id, master_asset_id, state, analysis, selection, approved_by')
    .eq('id', studioId).maybeSingle();
  if (!row || row.state !== 'finalising') { log(`${studioId}: not finalising, nothing to do`); return; }

  const { data: asset } = await supabase
    .from('video_assets').select('id, storage_provider, storage_bucket, storage_path, bytes, filename, mime_type, state')
    .eq('id', row.master_asset_id ?? '00000000-0000-0000-0000-000000000000').maybeSingle();
  const progress = async (line: string) => { await supabase.from('video_studio').update({ progress: line }).eq('id', studioId); };
  let maxMasterBytes = DEFAULT_MAX_MASTER_BYTES;
  try {
    const { data } = await supabase.from('installed_modules').select('config').eq('id', 'videos').maybeSingle();
    const n = Number((data?.config ?? {}).studio_max_master_bytes);
    if (Number.isFinite(n) && n > 0) maxMasterBytes = n;
  } catch { /* default */ }

  try {
    if (!asset || asset.state !== 'ready') throw new Error('the master this analysis was made on is no longer the ready one; run the analysis again');
    const outputs = await finalizeStudio(supabase, {
      studioId, videoId: String(row.video_id), analysis: row.analysis ?? {}, selection: row.selection ?? {}, asset,
      approvedBy: row.approved_by ?? null, maxMasterBytes, progress, log,
    });
    // Once a cut master exists the trim and the card are IN it. The
    // selection drops them so a second approval (a new headline, say) only
    // re-renders the thumbnail, and the analysis is marked as made on the
    // old master so the trim timeline is not offered against the new one.
    const sel = { ...(row.selection ?? {}) };
    if (outputs.master_asset_id) { sel.trim_in = null; sel.trim_out = null; sel.preroll = false; }
    const upd = await supabase.from('video_studio').update({
      state: 'approved', progress: null, error: null, outputs, selection: sel, approved_at: new Date().toISOString(),
      ...(outputs.master_asset_id ? { master_asset_id: outputs.master_asset_id } : {}),
    }).eq('id', studioId);
    if (upd.error) throw new Error(upd.error.message);
    log(`${studioId}: approved; thumbnail ${outputs.thumbnail_asset_id}${outputs.master_asset_id ? `, new master ${outputs.master_asset_id}` : ''}`);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    log(`${studioId}: finalize failed: ${msg}`);
    // Back to ready: the editor's choices are intact and they can try again.
    await supabase.from('video_studio').update({ state: 'ready', progress: null, error: msg }).eq('id', studioId);
  }
}
