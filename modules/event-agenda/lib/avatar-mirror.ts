/**
 * Copy an imported speaker avatar into our own storage bucket.
 *
 * Until now the importer stored the programme's own avatar URL and every
 * visitor's browser fetched it from there. Three things are wrong with that.
 * Sched's CDN sees the IP and user agent of everyone who looks at one of our
 * agendas. The image disappears when the conference takes its site down,
 * which is the exact moment a recap page starts being read. And the speaker
 * promo kits, the recap composer and the newsletter blocks all need the bytes
 * server-side, not a URL they have to go and fetch.
 *
 * So the importer now downloads the avatar once and serves it from the `media`
 * bucket. The remote URL is only used as a fallback when the copy fails, so a
 * flaky CDN degrades to the old behaviour rather than losing the avatar.
 *
 * What this file will NOT do:
 *
 *   - Fetch a host that is not in AVATAR_HOST_ALLOWLIST. The guard in
 *     import-safety.ts is reused rather than reimplemented, so the allowlist,
 *     the private-address check, the redirect walk and the timeout are the
 *     same ones the programme fetch goes through.
 *   - Store anything it has not confirmed is a raster image by reading its
 *     leading bytes. `media` is a world-readable bucket served from our own
 *     origin (its RLS policy is `USING (bucket_id = 'media')`, with no path
 *     or role predicate), so an SVG stored there is a stored XSS on our
 *     domain. A declared content type is the uploader's claim, not a fact.
 */

import { createHash } from 'node:crypto';

import { AVATAR_HOST_ALLOWLIST, FetchRefused, guardedFetchBytes, safeAvatarUrl } from './import-safety.js';

/** The platform's public bucket. Avatars are not secret. */
export const AVATAR_BUCKET = 'media';

/** Where mirrored avatars live, so one prefix can be reasoned about later. */
export const AVATAR_PREFIX = 'event-agenda/speaker-avatars';

/**
 * 3MB. The biggest avatar on the AGNTcon EU programme is 94KB; sched caps its
 * own uploads well below this. The number exists to stop a programme page
 * pointing at a 2GB file, not to accommodate a real photograph.
 */
export const AVATAR_MAX_BYTES = 3 * 1024 * 1024;

/**
 * The image types we will store, and the extension each one gets.
 *
 * Raster only. There is no SVG here and adding one is not a small change: see
 * the header comment.
 */
export const AVATAR_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Identify an image from its leading bytes.
 *
 * Returns null for anything not recognised, which includes an SVG, an HTML
 * error page served with a 200, and a zero-length body. The Content-Type
 * header is deliberately not consulted: a host that wants to get an SVG past
 * us would simply label it image/png.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'image/png';
  if (b.length >= 6) {
    const head = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (b.length >= 12) {
    const riff = String.fromCharCode(b[0], b[1], b[2], b[3]);
    const webp = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return null;
}

/**
 * A stable path for one remote avatar.
 *
 * Keyed on the remote URL, not on the bytes, for two reasons. A re-import can
 * then recognise an avatar it already has without downloading it again, which
 * matters because the nightly sweep re-reads every programme. And sched's URLs
 * already carry a cache-busting suffix that changes when the speaker uploads a
 * new photo, so a new photo lands on a new path rather than being missed.
 */
export function avatarStoragePath(remoteUrl: string, ext: string): string {
  const digest = createHash('sha256').update(String(remoteUrl)).digest('hex').slice(0, 32);
  const safeExt = /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin';
  return `${AVATAR_PREFIX}/${digest}.${safeExt}`;
}

/**
 * The browser-facing URL for a stored object.
 *
 * A full URL, not a bare storage path. `events_speaker_profiles.avatar_url`
 * holds both shapes today (11 bare paths from the promo flow, 6 full URLs from
 * speaker submissions) and only some consumers resolve a bare path, so the
 * shape that every consumer already handles is the right one to write.
 *
 * SUPABASE_PUBLIC_URL, not SUPABASE_URL: the latter is an in-cluster hostname
 * a browser cannot resolve. Returns null when neither is configured, and the
 * caller then keeps hot-linking rather than storing a URL nobody can load.
 */
export function publicAvatarUrl(storagePath: string): string | null {
  const base = (process.env.SUPABASE_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/storage/v1/object/public/${AVATAR_BUCKET}/${storagePath}`;
}

export interface MirrorResult {
  /** The URL to store on the profile. */
  url: string;
  /** Null when the copy failed and `url` is the remote one. */
  storagePath: string | null;
  mime: string | null;
  bytes: number;
  /** True when the object was already in the bucket and nothing was fetched. */
  reused: boolean;
  /** Set when the copy failed, for the log line. */
  skippedReason?: string;
}

export interface MirrorDeps {
  supabase: {
    storage: {
      from: (bucket: string) => {
        list: (prefix: string, opts: Record<string, unknown>) => Promise<{ data?: Array<{ name: string }> | null; error?: { message: string } | null }>;
        upload: (path: string, body: unknown, opts: Record<string, unknown>) => Promise<{ error?: { message: string } | null }>;
      };
    };
  };
  log?: (message: string) => void;
  /** Injected in tests. Defaults to the guarded fetch. */
  fetchBytes?: typeof guardedFetchBytes;
  allowlist?: string[];
  /**
   * Filenames already in the prefix, from listMirroredAvatars().
   *
   * Pass this when mirroring a whole programme. Without it each avatar costs
   * one storage list call per candidate extension, which for a 111-speaker
   * programme is 444 round trips before a single byte is fetched. With it the
   * whole prefix is read once.
   */
  existing?: Set<string>;
}

/** Every mirrored avatar filename currently in the bucket. */
export async function listMirroredAvatars(deps: Pick<MirrorDeps, 'supabase'>): Promise<Set<string>> {
  const names = new Set<string>();
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const res = await deps.supabase.storage
      .from(AVATAR_BUCKET)
      .list(AVATAR_PREFIX, { limit: page, offset })
      .catch(() => ({ data: null, error: { message: 'list threw' } }));
    const batch = res?.data ?? [];
    for (const o of batch) if (o?.name) names.add(o.name);
    // A short page is the last page. Also stop on an error, which leaves the
    // set incomplete and therefore only costs a re-download, never a wrong
    // answer, because upload runs with upsert.
    if (batch.length < page || res?.error) break;
  }
  return names;
}

/**
 * Copy one avatar into the bucket.
 *
 * Returns the mirrored URL on success. On any failure it returns the validated
 * remote URL with `storagePath: null`, so the caller still gets an avatar and
 * the only cost of a bad CDN day is that we hot-link for another night. It
 * returns null only when the input is not a URL we would ever use.
 */
export async function mirrorAvatar(
  deps: MirrorDeps,
  rawUrl: unknown,
): Promise<MirrorResult | null> {
  const allowlist = deps.allowlist ?? AVATAR_HOST_ALLOWLIST;
  const remote = safeAvatarUrl(rawUrl, allowlist);
  if (!remote) return null;

  const log = deps.log ?? (() => {});
  const fetchBytes = deps.fetchBytes ?? guardedFetchBytes;
  const fallback = (reason: string): MirrorResult => {
    log(`avatar mirror skipped (${reason}) — hot-linking ${remote}`);
    return { url: remote, storagePath: null, mime: null, bytes: 0, reused: false, skippedReason: reason };
  };

  // Nothing to gain from downloading an image we cannot then address. This is
  // checked before the fetch, not after, so a misconfigured environment costs
  // no bandwidth.
  if (!publicAvatarUrl('probe')) return fallback('SUPABASE_PUBLIC_URL is not set');

  // Already have it? The path carries the image type, so each candidate
  // extension is a separate filename to check. The nightly sweep re-reads
  // every programme, so this is the branch that runs almost every time.
  for (const ext of new Set(Object.values(AVATAR_TYPES))) {
    const candidate = avatarStoragePath(remote, ext);
    const name = candidate.slice(candidate.lastIndexOf('/') + 1);
    const present = deps.existing
      ? deps.existing.has(name)
      : await objectExists(deps, candidate, name);
    if (present) {
      return { url: publicAvatarUrl(candidate)!, storagePath: candidate, mime: null, bytes: 0, reused: true };
    }
  }

  let fetched: Awaited<ReturnType<typeof guardedFetchBytes>>;
  try {
    fetched = await fetchBytes(remote, allowlist, AVATAR_MAX_BYTES);
  } catch (err) {
    return fallback(err instanceof FetchRefused ? err.message : `fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!fetched.ok) return fallback(`HTTP ${fetched.status}`);
  if (fetched.bytes.length === 0) return fallback('empty body');

  const mime = sniffImageType(fetched.bytes);
  if (!mime) {
    // Worth naming the declared type in the log: a mismatch between it and
    // the bytes is the interesting case, not a plain 404.
    return fallback(`not a raster image (declared ${fetched.contentType || 'nothing'})`);
  }

  const storagePath = avatarStoragePath(remote, AVATAR_TYPES[mime]);
  const up = await deps.supabase.storage
    .from(AVATAR_BUCKET)
    .upload(storagePath, fetched.bytes, {
      contentType: mime,
      // A year. The path changes when the image does, so there is nothing to
      // revalidate; this is the one case where a long cache is simply correct.
      cacheControl: '31536000',
      // Upsert so a half-finished earlier run cannot wedge the path. The
      // content is addressed by the source URL, so a rewrite writes the same
      // thing.
      upsert: true,
    })
    .catch((err: unknown) => ({ error: { message: err instanceof Error ? err.message : String(err) } }));
  if (up?.error) return fallback(`upload failed: ${up.error.message}`);

  return {
    url: publicAvatarUrl(storagePath)!,
    storagePath,
    mime,
    bytes: fetched.bytes.length,
    reused: false,
  };
}

/** One-object existence check, for a caller mirroring a single avatar. */
async function objectExists(deps: MirrorDeps, path: string, name: string): Promise<boolean> {
  const res = await deps.supabase.storage
    .from(AVATAR_BUCKET)
    .list(path.slice(0, path.lastIndexOf('/')), { search: name, limit: 1 })
    .catch(() => ({ data: null, error: { message: 'list threw' } }));
  return Boolean(res?.data?.some((o) => o?.name === name));
}

/** True when a stored URL is one of ours, so a backfill can skip it. */
export function isMirroredAvatarUrl(value: unknown): boolean {
  return typeof value === 'string' && value.includes(`/${AVATAR_BUCKET}/${AVATAR_PREFIX}/`);
}
