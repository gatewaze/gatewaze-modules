/**
 * Relighting an album's photographs, from the Media tab.
 *
 * The sibling of enhanceMedia.ts, and the same shape: the server does
 * the model call and leaves a draft in storage, and the work on pixels
 * happens here, on a canvas, because the api pod has 512MB and decoding
 * a twelve-megapixel JPEG beside everything else it does cost the site
 * two outages.
 *
 * The one thing this does that the standard enhancement does not is pull
 * the colour back. ControlLight warms every photograph it touches --
 * measured across the wedding's night-before album on 2026-09-29, red
 * rose against green on all seven, and the copies read as too warm. The
 * drift is different on each, so it is measured here against the
 * original rather than corrected by a fixed amount: what comes out has
 * the model's light and the photograph's own colour.
 *
 * Unlike the standard enhancement, this one INVENTS. It is stored under
 * its own key and shown only where an organiser has asked for it by
 * name.
 */
import { supabase } from '@/lib/supabase';
import { applyOps, channelMeans, meanLuma, neutraliseOps, relightLost } from '../../lib/enhance';

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const apiUrl = env.VITE_API_URL ?? '';

/** What one call asks for. The server caps it at the same number. */
export const AI_ENHANCE_BATCH = 3;
/**
 * The longest edge of a relit copy. The model returns about a megapixel
 * and the portal shows 800px; the original is kept untouched.
 */
const MAX_EDGE = 2560;

export interface AiEnhanceProgress {
  done: number;
  total: number;
  relit: number;
  skipped: number;
  failed: number;
  /** Came back, but not as the photograph any more. */
  refused: number;
}

interface Relit {
  id: string;
  status: 'needs' | 'unchanged' | 'skipped' | 'failed';
  reason?: string;
  source?: string;
  draft?: string;
  of?: 'photo' | 'selfie';
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  const token = session.session?.access_token;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  return fetch(`${apiUrl}${path}`, { ...init, headers });
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // The canvas has to be readable afterwards.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load the photo'));
    img.src = src;
  });
}

/** What one image measures, at a size that costs nothing to read. */
async function measure(src: string): Promise<{
  channels: ReturnType<typeof channelMeans>; luma: number;
}> {
  const img = await load(src);
  const scale = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  return { channels: channelMeans(data), luma: meanLuma(data) };
}

/** The model answered, and the answer was not the photograph. */
class Refused extends Error {}

/**
 * The draft with the model's warm cast taken back out, as a JPEG.
 */
async function correct(source: string, draft: string): Promise<Blob> {
  // The original is measured small; the draft is worked on full size.
  const was = await measure(source);
  const img = await load(draft);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(img, 0, 0, w, h);
  const frame = ctx.getImageData(0, 0, w, h);
  // The model usually returns something usable and occasionally does
  // not: over the wedding's 301 copies it returned one entirely black
  // frame and halved the light in four good photographs. A valid JPEG
  // of a plausible size is not enough to go on.
  if (relightLost(was.luma, meanLuma(frame.data))) {
    throw new Refused('the relit copy is not the photograph any more');
  }
  applyOps(frame.data, w, h, neutraliseOps(was.channels, channelMeans(frame.data)));
  ctx.putImageData(frame, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('could not encode the relit photo');
  return blob;
}

/**
 * Walk a list of photographs. `onProgress` is called as each finishes;
 * returning false from `keepGoing` stops the walk, and what has been
 * done stays done -- one already relit is skipped when the album is run
 * again, which is what keeps a second run from being paid for twice.
 */
export async function aiEnhanceMedia(
  eventId: string,
  ids: string[],
  onProgress: (p: AiEnhanceProgress) => void,
  keepGoing: () => boolean = () => true,
  bucket = 'media',
  /** Relight ones already relit, and remake the copies. */
  force = false,
): Promise<AiEnhanceProgress> {
  const progress: AiEnhanceProgress = { done: 0, total: ids.length, relit: 0, skipped: 0, failed: 0, refused: 0 };

  for (let i = 0; i < ids.length; i += AI_ENHANCE_BATCH) {
    if (!keepGoing()) break;
    const batch = ids.slice(i, i + AI_ENHANCE_BATCH);
    const resp = await authedFetch(`/api/admin/events/${eventId}/media/ai-enhance`, {
      method: 'POST',
      body: JSON.stringify({ ids: batch, force }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      throw new Error(body?.message ?? `The relighting stopped after ${progress.done} photos`);
    }
    const { results } = (await resp.json()) as { results: Relit[] };

    for (const r of results ?? []) {
      if (r.status !== 'needs' || !r.source || !r.draft) {
        if (r.status === 'unchanged' || r.status === 'skipped') progress.skipped += 1;
        else progress.failed += 1;
        progress.done += 1;
        onProgress({ ...progress });
        continue;
      }
      try {
        const blob = await correct(r.source, r.draft);
        // Beside the photograph, under a new name each time: a CDN caches
        // by name and would go on serving the copy this replaces.
        const dir = new URL(r.source).pathname.replace(/^.*\/public\/[^/]+\//, '');
        const folder = dir.slice(0, dir.lastIndexOf('/'));
        const path = `${folder}/ai-${Date.now().toString(36)}.jpg`;
        const up = await supabase.storage.from(bucket).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw new Error(up.error.message);
        const rec = await authedFetch(`/api/admin/events/${eventId}/media/ai-enhanced`, {
          method: 'POST',
          body: JSON.stringify({ media_id: r.id, storage_path: path, bytes: blob.size }),
        });
        if (!rec.ok) throw new Error('could not record the relit photo');
        progress.relit += 1;
      } catch (err) {
        // A refusal is not a failure to retry: the model answered, and
        // the answer was not usable. Tell the server so the draft is
        // swept and a later run knows not to pay for it again.
        if (err instanceof Refused) {
          progress.refused += 1;
          await authedFetch(`/api/admin/events/${eventId}/media/ai-enhanced`, {
            method: 'POST',
            body: JSON.stringify({ media_id: r.id, refused: true }),
          }).catch(() => undefined);
        } else {
          // One photograph that will not relight must not stop the album.
          progress.failed += 1;
        }
      }
      progress.done += 1;
      onProgress({ ...progress });
    }
  }
  return progress;
}
