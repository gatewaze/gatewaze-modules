// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos:studio-upload — turn an uploaded speaker photo into a cut-out frame.
 *
 * Job data: { studio_id, path }. The photo is laid onto a 1920x1080
 * canvas (fitted, feet to the floor), then either kept as it is when it
 * already has transparency (a cut-out the editor made elsewhere) or cut out
 * with the same birefnet pass the video frames get. The result joins the
 * analysis's cuts as the selected one. The studio row's `progress` says
 * what is happening while it runs and is cleared after.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, ffmpegBytes } from '../lib/ffmpeg.js';
import { cutOut } from '../lib/cutout.js';
import { alphaBounds, glareFraction } from '../lib/studio-pixels.js';
import { getMedia, putMedia, studioFolder } from '../lib/studio-media.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const W = 1920; const H = 1080;

/** Does an RGBA buffer carry any real transparency? */
export function hasAlpha(rgba: Buffer, step = 17): boolean {
  let clear = 0; let n = 0;
  for (let i = 3; i < rgba.length; i += 4 * step) { n++; if (rgba[i] < 250) clear++; }
  return n > 0 && clear / n > 0.02;
}

export default async function studioUploadHandler(job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos:studio] ${m}`);
  const studioId = String(job?.data?.studio_id ?? '');
  const path = String(job?.data?.path ?? '');
  if (!UUID_RE.test(studioId) || !path.startsWith('video-studio/')) { log('studio-upload: bad job data'); return; }

  const { data: row } = await supabase.from('video_studio').select('id, video_id, analysis, selection').eq('id', studioId).maybeSingle();
  if (!row) return;
  const work = await mkdtemp(join(tmpdir(), 'studio-upload-'));
  try {
    const src = join(work, 'src' + (path.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png'));
    await writeFile(src, await getMedia(supabase, path));
    // Onto the canvas: fit inside 1920x1080, centred across, feet on the floor.
    const canvas = join(work, 'canvas.png');
    await ffmpeg(['-i', src, '-vf', `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease,format=rgba,pad=${W}:${H}:(ow-iw)/2:(oh-ih):color=black@0`, canvas]);
    const raw = await ffmpegBytes(['-i', canvas, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);

    let png: Buffer; let bbox; let glare = 0; let screen = 0; let luma = 0; let gamma = 1; let lecternJoined = false;
    if (hasAlpha(raw)) {
      png = await readFile(canvas);
      bbox = alphaBounds(raw, W, H);
      if (bbox) glare = glareFraction(raw, W, bbox);
    } else {
      const jpg = join(work, 'frame.jpg');
      await ffmpeg(['-i', canvas, '-q:v', '2', jpg]);
      const r = await cutOut({ frame: await readFile(jpg), width: W, height: H, cameraCrop: null, lectern: false });
      png = r.png; bbox = r.bbox; glare = r.glare; screen = r.screen; luma = r.meanLuma; gamma = r.gamma; lecternJoined = r.lecternJoined;
    }
    if (!bbox) throw new Error('nothing was found in the photo to cut out');
    const key = `cut-upload-${Date.now()}`;
    const folder = studioFolder(String(row.video_id), studioId);
    const stored = await putMedia(supabase, `${folder}/${key}.png`, png, 'image/png');
    const cut = {
      key, t: null, path: stored, source: 'upload',
      bbox: [Number((bbox.x0 / W).toFixed(3)), Number((bbox.y0 / H).toFixed(3)), Number((bbox.x1 / W).toFixed(3)), Number((bbox.y1 / H).toFixed(3))],
      meta: { note: 'uploaded photo' }, glare: Number(glare.toFixed(3)), screen: Number(screen.toFixed(3)), luma, gamma,
      lectern_joined: lecternJoined, camera_crop: false, passes: true,
    };
    const a = row.analysis ?? {};
    const upd = await supabase.from('video_studio').update({
      analysis: { ...a, cuts: [cut, ...(a.cuts ?? [])] },
      selection: { ...(row.selection ?? {}), cut: key },
      progress: null, error: null,
    }).eq('id', studioId);
    if (upd.error) throw new Error(upd.error.message);
    log(`${studioId}: uploaded photo cut out as ${key}`);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 300);
    log(`${studioId}: upload cut-out failed: ${msg}`);
    await supabase.from('video_studio').update({ progress: null, error: `the uploaded photo could not be cut out: ${msg}` }).eq('id', studioId);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
