/**
 * Turning a photograph that came in on its side.
 *
 * The turning happens here, in the organiser's browser: it already has
 * the picture on screen, and a canvas turns one in a moment. The 3D
 * layers are turned with it -- a rotated photograph over an upright
 * background would tear itself apart on the projector -- and everything
 * is written to new names, because a CDN caches by name and would go on
 * serving the old picture for hours.
 *
 * api/rotate-media.ts then points the row at the new files and removes
 * the old ones. It checks the paths and that the files exist, so nothing
 * here is trusted on the way through.
 */
import { supabase } from '@/lib/supabase';
import { uploadBeside } from './uploadBeside';

/**
 * The layers that must turn with the photograph. thumb and medium are
 * usually resizes of the original computed on the way out, in which case
 * they are URLs and skipped below -- but a row that has real stored
 * files for them needs those turned as well.
 */
const LAYERS = ['plate', 'cutout', 'depth', 'hires', 'thumb', 'medium'] as const;

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const apiUrl = env.VITE_API_URL ?? '';

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
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

/** One picture, turned by quarter turns clockwise. */
async function turn(src: string, quarters: number, type: string): Promise<{ blob: Blob; width: number; height: number }> {
  const img = await load(src);
  const swap = quarters % 2 === 1;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? img.naturalHeight : img.naturalWidth;
  canvas.height = swap ? img.naturalWidth : img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((quarters * Math.PI) / 2);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, type === 'image/png' ? undefined : 0.92));
  if (!blob) throw new Error('could not encode');
  return { blob, width: canvas.width, height: canvas.height };
}

export interface RotatableItem {
  id: string;
  storage_path?: string | null;
  cdn_url: string;
  variants?: Record<string, string> | null;
}

/**
 * Turn a photograph and its layers, and point the row at the result.
 * Returns the updated row's fields, or throws with something an
 * organiser can read.
 */
export async function rotateMedia(
  eventId: string,
  item: RotatableItem,
  quarters: 1 | 2 | 3,
  // Unused: the server now chooses where the file goes. Kept so existing
  // callers that pass a bucket still compile.
  _bucket = 'media',
): Promise<{ storage_path: string; width: number; height: number }> {
  const original = item.storage_path ?? '';
  if (!original) throw new Error('this photo has no file to turn');
  const stamp = Date.now().toString(36);

  // The picture itself, from the original rather than a thumbnail.
  const base = urlFor(item.cdn_url, original, original);
  const turned = await turn(base, quarters, 'image/jpeg');
  let path: string;
  try {
    path = await uploadBeside(authedFetch, eventId, item.id, `rot-${stamp}.jpg`, turned.blob);
  } catch (err) {
    throw new Error(`could not save the turned photo: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The layers, turned the same way so they still line up.
  const variants: Record<string, string> = {};
  for (const key of LAYERS) {
    const at = item.variants?.[key];
    if (!at || /^https?:/i.test(at)) continue;
    try {
      const png = key === 'cutout' || key === 'depth';
      const out = await turn(urlFor(item.cdn_url, original, at), quarters, png ? 'image/png' : 'image/jpeg');
      const ext = png ? 'png' : 'jpg';
      variants[key] = await uploadBeside(authedFetch, eventId, item.id, `rot-${key}-${stamp}.${ext}`, out.blob);
    } catch {
      // A layer that cannot be turned is left behind rather than left
      // pointing the wrong way: the server only replaces what it is given.
    }
  }

  const resp = await authedFetch(`/api/admin/events/${eventId}/media/${item.id}/rotated`, {
    method: 'POST',
    body: JSON.stringify({
      storage_path: path,
      width: turned.width,
      height: turned.height,
      bytes: turned.blob.size,
      quarters,
      variants,
    }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    throw new Error(body?.message ?? 'could not save the rotation');
  }
  return { storage_path: path, width: turned.width, height: turned.height };
}

/**
 * A public URL for a stored path, taken from the row's own cdn_url so it
 * keeps working whatever the storage host is: the cdn_url is the
 * original's path on some host, so the host part is everything before it.
 */
export function urlFor(cdnUrl: string, original: string, path: string): string {
  if (/^https?:/i.test(path)) return path;
  const bare = cdnUrl.split(/[?#]/)[0]!;
  for (const tail of [original, original.split('/').map(encodeURIComponent).join('/')]) {
    if (bare.endsWith(`/${tail}`)) return bare.slice(0, bare.length - tail.length) + path;
  }
  throw new Error('cannot work out where this photo is stored');
}
