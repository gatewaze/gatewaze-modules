// Image URLs on the public calendars API. The worker and the admin upload
// field store a calendar's cover (and sometimes its logo) as a path in the
// `media` bucket, e.g. `calendars/CAL-AAIFLONDON-cover.png`, which means
// nothing to an API caller. The portal resolves these at render time
// (CalendarHero); this does the same for the API.

import { storagePublicConfig, storagePublicUrl } from '../../storage/lib/public-url.js';

const HTTP_URL = /^https?:\/\//i;
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A full public URL for a stored image, or null. Absolute http(s) URLs pass
 * through. A brand that has moved off Supabase Storage (STORAGE_PUBLIC_URL)
 * is served from there; otherwise the Supabase public object URL is built
 * from the public base (SUPABASE_PUBLIC_URL, which the browser can reach,
 * before SUPABASE_URL).
 */
export function toPublicImageUrl(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (HTTP_URL.test(v)) return v;
  if (OTHER_SCHEME.test(v) || v.includes('..')) return null;

  const path = v.replace(/^\/+/, '');
  const moved = storagePublicUrl(storagePublicConfig(env), 'media', path);
  if (moved) return moved;

  const base = String(env.SUPABASE_PUBLIC_URL || env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/storage/v1/object/public/media/${path.split('/').map(encodeURIComponent).join('/')}`;
}
