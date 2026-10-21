// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * What approval produces: the thumbnail, and, when the editor trimmed or
 * asked for the card, a new master with the cut applied and the card in
 * front.
 *
 * The thumbnail is the artboard the editor saw, rendered at 1280x720 by
 * Chromium from the same markup, written to the media bucket as a
 * `thumbnail` asset and set as the video's thumbnail_url. The new master is
 * uploaded to wherever masters go, recorded as a `master` asset with
 * source 'studio', and the previous master is superseded (its object stays
 * in the bucket; only the row's state changes).
 */

import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg } from './ffmpeg.js';
import { artboardPage, clampSelection, type ArtboardInput } from './artboard.js';
import { renderHtmlToPng } from './chromium.js';
import { loadStudioAssets } from './studio-assets.js';
import { assemble, renderCardPng, type CardSpeaker } from './preroll.js';
import { downloadMaster, getMedia, putMedia, mediaUrl, studioFolder, MEDIA_BUCKET } from './studio-media.js';
import { storeForNew } from './storage.js';
import { resolveLogo, logoDataUri } from './studio-logo.js';
import type { Analysis } from './studio-analyse.js';

export interface Selection {
  cut?: string | null;
  scale?: number;
  x?: number;
  y?: number | null;
  lead?: string;
  emph?: string;
  panels?: boolean;
  /** Which panels show, in order, at most two; null means the first two. */
  panel_keys?: string[] | null;
  trim_in?: number | null;
  trim_out?: number | null;
  preroll?: boolean;
  card_title?: string | null;
  card_speakers?: CardSpeaker[] | null;
}

export interface FinalizeArgs {
  studioId: string;
  videoId: string;
  analysis: Analysis;
  selection: Selection;
  asset: { id: string; storage_provider?: string | null; storage_bucket: string; storage_path: string; bytes?: number | null; filename?: string | null; mime_type?: string | null };
  approvedBy: string | null;
  maxMasterBytes: number;
  progress: (line: string) => Promise<void>;
  log?: (m: string) => void;
}

export interface Outputs {
  thumbnail_asset_id: string;
  thumbnail_path: string;
  thumbnail_url: string;
  master_asset_id: string | null;
  duration_seconds: number | null;
  reencoded: boolean;
  trimmed: boolean;
  prerolled: boolean;
}

function dataUri(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** The panels the editor chose, in their order, two at most; the first two when nothing was chosen. */
export function chosenPanels<T extends { key: string }>(panels: T[], sel: { panels?: boolean; panel_keys?: string[] | null }): T[] {
  if (sel.panels === false) return [];
  if (Array.isArray(sel.panel_keys)) {
    return sel.panel_keys.map((k) => panels.find((p) => p.key === k)).filter((p): p is T => Boolean(p)).slice(0, 2);
  }
  return panels.slice(0, 2);
}

export async function finalizeStudio(supabase, args: FinalizeArgs): Promise<Outputs> {
  const log = args.log ?? (() => {});
  const folder = studioFolder(args.videoId, args.studioId);
  const assets = await loadStudioAssets();
  const sel = args.selection;
  const a = args.analysis;

  // 1. The thumbnail.
  await args.progress('Rendering the thumbnail');
  const cut = a.cuts.find((c) => c.key === sel.cut) ?? a.cuts[0] ?? null;
  const panels = chosenPanels(a.panels ?? [], sel);
  const logo = await resolveLogo(supabase, args.videoId, a.context);
  const input: ArtboardInput = {
    backgroundSrc: assets.thumbnailBg,
    logoSrc: assets.logo,
    cutSrc: cut ? dataUri(await getMedia(supabase, cut.path), 'image/png') : null,
    panelSrcs: await Promise.all(panels.map(async (p) => dataUri(await getMedia(supabase, p.path), p.path.endsWith('.png') ? 'image/png' : 'image/jpeg'))),
    markSrc: await logoDataUri(supabase, logo),
    cutBounds: cut?.bbox ?? null,
    selection: clampSelection({ scale: sel.scale, x: sel.x, y: sel.y, lead: sel.lead, emph: sel.emph, panels: sel.panels }),
  };
  const png = await renderHtmlToPng(artboardPage(input, { archivo: assets.fonts.archivo }), 1280, 720, 1);
  const work = await mkdtemp(join(tmpdir(), 'studio-final-'));
  let masterAssetId: string | null = null;
  let duration: number | null = null;
  let result = { reencoded: false, trimmed: false, prerolled: false };
  try {
    const pngPath = join(work, 'thumb.png'); const jpgPath = join(work, 'thumb.jpg');
    await (await import('node:fs/promises')).writeFile(pngPath, png);
    await ffmpeg(['-i', pngPath, '-q:v', '2', jpgPath]);
    const stamp = Date.now();
    const thumbPath = await putMedia(supabase, `${folder}/thumbnail-${stamp}.jpg`, await (await import('node:fs/promises')).readFile(jpgPath), 'image/jpeg');
    const thumbUrl = mediaUrl(supabase, thumbPath);
    const thumbIns = await supabase.from('video_assets').insert({
      video_id: args.videoId, kind: 'thumbnail', storage_bucket: MEDIA_BUCKET, storage_provider: 'supabase', storage_path: thumbPath,
      filename: `thumbnail-${stamp}.jpg`, mime_type: 'image/jpeg', bytes: (await stat(jpgPath)).size, width: 1280, height: 720,
      state: 'ready', source: 'studio', uploaded_by: args.approvedBy,
    }).select('id').single();
    if (thumbIns.error) throw new Error(thumbIns.error.message);
    await supabase.from('videos').update({ thumbnail_url: thumbUrl }).eq('id', args.videoId);

    // 2. The cut, when asked for.
    const wantsTrim = (sel.trim_in != null && sel.trim_in > 0.05) || (sel.trim_out != null && sel.trim_out < a.duration - 0.05);
    const wantsCard = sel.preroll === true;
    if (wantsTrim || wantsCard) {
      await args.progress(wantsCard ? 'Making the talk card' : 'Cutting the master');
      const cardPng = wantsCard
        ? await renderCardPng({
          title: String(sel.card_title ?? a.context?.title ?? '').trim() || a.context?.title || 'Talk',
          speakers: (Array.isArray(sel.card_speakers) && sel.card_speakers.length ? sel.card_speakers : (a.context?.speakers ?? []))
            .map((s) => ({ name: String(s.name ?? ''), role: s.role ?? null, company: s.company ?? null })),
        }, { cardBg: assets.cardBg, figtree: assets.fonts.figtree })
        : null;
      await args.progress('Fetching the master');
      const master = await downloadMaster(supabase, args.asset, args.maxMasterBytes);
      try {
        await args.progress(wantsCard ? 'Joining the card and the talk' : 'Cutting the master');
        const outPath = join(work, 'cut.mp4');
        const r = await assemble({ masterPath: master.path, trimIn: sel.trim_in ?? null, trimOut: sel.trim_out ?? null, cardPng, bedPath: assets.prerollBedPath, outPath });
        result = { reencoded: r.reencoded, trimmed: r.trimmed, prerolled: r.prerolled };
        duration = Math.round(r.durationSeconds);
        log(`assembled ${duration}s (trimmed ${r.trimmed}, card ${r.prerolled}, re-encoded ${r.reencoded})`);

        await args.progress('Uploading the new master');
        const store = storeForNew(supabase, 'master');
        const base = String(args.asset.filename ?? 'master.mp4')
          .replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.-]+/, '').slice(0, 120) || 'master';
        const ins = await supabase.from('video_assets').insert({
          video_id: args.videoId, kind: 'master', storage_bucket: store.bucket, storage_provider: store.provider, storage_path: 'pending',
          filename: `${base}-studio.mp4`, mime_type: 'video/mp4', state: 'uploading', source: 'studio', uploaded_by: args.approvedBy,
        }).select('id').single();
        if (ins.error) throw new Error(ins.error.message);
        masterAssetId = String(ins.data.id);
        try {
          const key = `studio/${args.videoId}/${masterAssetId}/${base}-studio.mp4`;
          await supabase.from('video_assets').update({ storage_path: key }).eq('id', masterAssetId);
          const { bytes } = await store.putStream(key, createReadStream(outPath), 'video/mp4');
          // Supersede the previous master only once the new object is there.
          await supabase.from('video_assets').update({ state: 'superseded' }).eq('video_id', args.videoId).eq('kind', 'master').eq('state', 'ready');
          const promote = await supabase.from('video_assets').update({ state: 'ready', bytes, duration_seconds: duration, width: a.width, height: a.height, error: null }).eq('id', masterAssetId);
          if (promote.error) throw new Error(promote.error.message);
          await supabase.from('videos').update({ duration_seconds: duration }).eq('id', args.videoId);
        } catch (err) {
          // Never leave an `uploading` row behind: the reaper would read it as
          // an abandoned editor upload, and the UI as something still coming.
          await supabase.from('video_assets').update({ state: 'failed', error: String((err as Error)?.message ?? err).slice(0, 300) })
            .eq('id', masterAssetId).eq('state', 'uploading');
          masterAssetId = null;
          throw err;
        }
      } finally {
        await master.dispose();
      }
    }

    return {
      thumbnail_asset_id: String(thumbIns.data.id), thumbnail_path: thumbPath, thumbnail_url: thumbUrl,
      master_asset_id: masterAssetId, duration_seconds: duration, ...result,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
