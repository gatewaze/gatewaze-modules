/**
 * Improving an album's photographs, from the Media tab.
 *
 * The server says what each photograph needs -- it asks the model, which
 * fetches the photograph itself -- and the work happens here, on a
 * canvas, exactly as turning a photograph on its side does. That is not
 * a preference: doing it on the server cost the site two outages, because
 * the api pod has 512MB for everything it does and a twelve-megapixel
 * JPEG decoded beside the projector's feed is enough to have it killed.
 * A browser has memory to spare and takes nobody else down with it.
 *
 * Nothing is drawn. The adjustments are arithmetic on pixels that are
 * already there (lib/enhance.ts), so no face can come back as somebody
 * else's.
 */
import { supabase } from '@/lib/supabase';
import { applyOps, darkPoint, meanLuma, withMeasuredTone, type EnhanceOps } from '../../lib/enhance';

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const apiUrl = env.VITE_API_URL ?? '';

/** What one call asks about. The server caps it at the same number. */
export const ENHANCE_BATCH = 3;
/**
 * The longest edge of an enhanced copy. It is a copy for looking at --
 * the portal shows it at 800px -- and the original is kept untouched at
 * whatever size it arrived.
 */
const MAX_EDGE = 2560;

export interface EnhanceProgress {
  done: number;
  total: number;
  enhanced: number;
  unchanged: number;
  failed: number;
}

interface Verdict {
  id: string;
  status: 'needs' | 'unchanged' | 'skipped' | 'failed';
  note?: string;
  reason?: string;
  source?: string;
  ops?: EnhanceOps;
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

/** The photograph, improved, as a JPEG. */
async function improve(source: string, ops: EnhanceOps): Promise<Blob> {
  const img = await load(source);
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
  // The model judges what kind of correction a photograph wants and is a
  // poor judge of how much -- it answered "a touch of sharpening" to
  // photographs taken in a very dark room. The pixels are not a matter of
  // opinion, so the exposure is corrected against what they measure.
  const lifted: EnhanceOps = withMeasuredTone(ops, meanLuma(frame.data), darkPoint(frame.data));
  applyOps(frame.data, w, h, lifted);
  ctx.putImageData(frame, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('could not encode the improved photo');
  return blob;
}

/**
 * Walk a list of photographs. `onProgress` is called as each one is
 * finished; returning false from `keepGoing` stops the walk, and what
 * has been done stays done -- a photograph already looked at is skipped
 * when the album is run again.
 */
export async function enhanceMedia(
  eventId: string,
  ids: string[],
  onProgress: (p: EnhanceProgress) => void,
  keepGoing: () => boolean = () => true,
  bucket = 'media',
  /** Look again at photographs already looked at, and remake the copies. */
  force = false,
): Promise<EnhanceProgress> {
  const progress: EnhanceProgress = { done: 0, total: ids.length, enhanced: 0, unchanged: 0, failed: 0 };

  for (let i = 0; i < ids.length; i += ENHANCE_BATCH) {
    if (!keepGoing()) break;
    const batch = ids.slice(i, i + ENHANCE_BATCH);
    const resp = await authedFetch(`/api/admin/events/${eventId}/media/enhance`, {
      method: 'POST',
      body: JSON.stringify({ ids: batch, force }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      throw new Error(body?.message ?? `The enhancement stopped after ${progress.done} photos`);
    }
    const { results } = (await resp.json()) as { results: Verdict[] };

    for (const r of results ?? []) {
      if (r.status !== 'needs' || !r.source || !r.ops) {
        if (r.status === 'unchanged') progress.unchanged += 1;
        else if (r.status !== 'skipped') progress.failed += 1;
        progress.done += 1;
        onProgress({ ...progress });
        continue;
      }
      try {
        const blob = await improve(r.source, r.ops);
        // Beside the photograph, under a new name each time: a CDN caches
        // by name and would go on serving the copy this replaces.
        const dir = new URL(r.source).pathname.replace(/^.*\/public\/[^/]+\//, '');
        const folder = dir.slice(0, dir.lastIndexOf('/'));
        const path = `${folder}/enhanced-${Date.now().toString(36)}.jpg`;
        const up = await supabase.storage.from(bucket).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw new Error(up.error.message);
        const rec = await authedFetch(`/api/admin/events/${eventId}/media/enhanced`, {
          method: 'POST',
          body: JSON.stringify({ media_id: r.id, storage_path: path, bytes: blob.size, of: r.of ?? 'photo' }),
        });
        if (!rec.ok) throw new Error('could not record the improved photo');
        progress.enhanced += 1;
      } catch {
        // One photograph that will not improve must not stop the album.
        progress.failed += 1;
      }
      progress.done += 1;
      onProgress({ ...progress });
    }
  }
  return progress;
}
