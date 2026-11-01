/**
 * Supabase Storage as a provider. Built into the storage module, so every
 * brand has it without enabling anything.
 *
 * Browser addresses come in three shapes, chosen by the settings:
 *
 *   - Plain: `<public supabase url>/storage/v1/object/public/<bucket>/<path>`.
 *   - Through a Bunny pull zone (BUNNY_CDN_ENABLED + BUNNY_PULLZONE_URL): the
 *     same path on the zone's host, and Bunny's Optimizer does the resizing.
 *   - Resized by Supabase (`/render/image/`) when there is no zone and
 *     resizing is on. Supabase bills per original picture resized a month.
 *
 * The plain and Bunny shapes are exactly what event-media and host-media
 * built by hand before this module, so moving them onto it changes no
 * address. Paths are not percent-encoded for the same reason: names are
 * sanitised on upload.
 */

import { assertFolderPrefix, assertSafeKey, clampInt, countedStream, defaultCacheControl, isBuffer, maxAgeSeconds, trimTrailingSlashes, versionParam } from './keys.js';
import type { HeadResult, ImageSize, ListEntry, ObjectStore, PutOptions, SignedUpload, SignUploadOptions, UrlOptions, Body } from './types.js';

export interface SupabaseStoreSettings {
  /** Where the server reaches Supabase; may be an in-cluster name. */
  internalUrl: string;
  /** Where a browser reaches Supabase. */
  publicUrl: string;
  /** A Bunny pull zone in front of this project's storage, or null. */
  bunnyZone: string | null;
  /** Use Supabase's own resizer when there is no Bunny zone. */
  supabaseResize: boolean;
}

/** Minimal supabase-js storage surface, so this file needs no supabase-js types. */
export interface SupabaseStorageClient {
  storage: {
    from(bucket: string): {
      upload(path: string, body: unknown, opts: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
      remove(paths: string[]): Promise<{ data?: unknown; error: { message: string } | null }>;
      createSignedUrl(path: string, expires: number): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
      createSignedUploadUrl(path: string, opts?: { upsert?: boolean }): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
      list(dir: string, opts: { limit: number; offset: number }): Promise<{ data: Array<{ name: string; id: string | null; metadata?: { size?: number } | null }> | null; error: { message: string } | null }>;
      copy(from: string, to: string): Promise<{ error: { message: string } | null }>;
    };
  };
}

const trimSlash = trimTrailingSlashes;

export function supabaseSettingsFromEnv(env: Record<string, string | undefined>): SupabaseStoreSettings {
  const internalUrl = trimSlash(String(env.SUPABASE_URL ?? '').trim());
  const publicUrl = trimSlash(String(env.SUPABASE_PUBLIC_URL || internalUrl).trim());
  const on = String(env.BUNNY_CDN_ENABLED ?? '').trim().toLowerCase() === 'true';
  const zone = trimSlash(String(env.BUNNY_PULLZONE_URL ?? '').trim());
  // Only an https origin with a plain host is accepted. A typo would
  // otherwise send every picture to a host that does not exist.
  const bunnyZone = on && /^https:\/\/[a-z0-9.-]+$/i.test(zone) ? zone : null;
  const resize = String(env.STORAGE_SUPABASE_RESIZE ?? 'true').trim().toLowerCase() !== 'false';
  return { internalUrl, publicUrl, bunnyZone, supabaseResize: resize };
}

/** Rewrite an in-cluster Supabase address to the one a browser can reach. */
export function externalise(url: string, s: Pick<SupabaseStoreSettings, 'internalUrl' | 'publicUrl'>): string {
  if (!s.internalUrl || s.internalUrl === s.publicUrl) return url;
  return url.startsWith(s.internalUrl) ? s.publicUrl + url.slice(s.internalUrl.length) : url;
}

export function supabaseStore(client: SupabaseStorageClient, settings: SupabaseStoreSettings, bucket: string): ObjectStore {
  const from = () => client.storage.from(bucket);
  const objectPath = (path: string) => `/storage/v1/object/public/${bucket}/${assertSafeKey(path)}`;

  async function signedRead(path: string, expires: number): Promise<string> {
    const signed = await from().createSignedUrl(assertSafeKey(path), expires);
    if (signed.error || !signed.data?.signedUrl) throw new Error(`could not sign a read: ${signed.error?.message ?? 'no url'}`);
    return signed.data.signedUrl;
  }

  return {
    provider: 'supabase',
    bucket,
    canResize: Boolean(settings.bunnyZone) || settings.supabaseResize,

    publicUrl(path: string, opts?: UrlOptions): string {
      return `${settings.bunnyZone ?? settings.publicUrl}${objectPath(path)}${versionParam(opts?.version, '?')}`;
    },

    sizedUrl(path: string, size: ImageSize, opts?: UrlOptions): string {
      const w = clampInt(size.width, 16, 4096);
      const q = clampInt(size.quality ?? 80, 1, 100);
      const h = size.height ? clampInt(size.height, 16, 4096) : null;
      const v = versionParam(opts?.version, '&');
      if (settings.bunnyZone) {
        // Bunny Optimizer: aspect_ratio=crop is its name for cover.
        const crop = size.fit === 'cover' && h ? `&height=${h}&aspect_ratio=crop` : (h ? `&height=${h}` : '');
        return `${settings.bunnyZone}${objectPath(path)}?width=${w}${crop}&quality=${q}${v}`;
      }
      if (!settings.supabaseResize) return this.publicUrl(path, opts);
      return `${settings.publicUrl}/storage/v1/render/image/public/${bucket}/${assertSafeKey(path)}` +
        `?width=${w}${h ? `&height=${h}` : ''}&resize=${size.fit === 'cover' ? 'cover' : 'contain'}&quality=${q}${v}`;
    },

    async put(path: string, body: Body, opts: PutOptions): Promise<{ bytes: number }> {
      const key = assertSafeKey(path);
      // supabase-js takes cacheControl as a number of seconds and writes
      // `max-age=<value>` itself, so pass only the seconds.
      const seconds = maxAgeSeconds(opts.cacheControl ?? defaultCacheControl(opts.upsert)) ?? 3600;
      const common = { contentType: opts.contentType, upsert: opts.upsert === true, cacheControl: String(seconds) };
      if (isBuffer(body)) {
        if (opts.maxBytes && body.byteLength > opts.maxBytes) throw new Error('body is over the size limit');
        const up = await from().upload(key, body, common);
        if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);
        return { bytes: body.byteLength };
      }
      const { stream, count } = countedStream(body, opts.maxBytes);
      const up = await from().upload(key, stream, { ...common, duplex: 'half' });
      if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);
      return { bytes: count() };
    },

    async signUpload(path: string, opts: SignUploadOptions): Promise<SignedUpload> {
      // Supabase's signed upload is single-use and expires after two hours;
      // it cannot pin the size, so callers check it with head() afterwards.
      const signed = await from().createSignedUploadUrl(assertSafeKey(path));
      if (signed.error || !signed.data?.signedUrl) throw new Error(`could not sign an upload: ${signed.error?.message ?? 'no url'}`);
      return { url: externalise(signed.data.signedUrl, settings), method: 'PUT', headers: { 'content-type': opts.contentType } };
    },

    async signRead(path: string, expiresSeconds: number, opts?: { forServer?: boolean }): Promise<string> {
      const url = await signedRead(path, expiresSeconds);
      return opts?.forServer ? url : externalise(url, settings);
    },

    async head(path: string): Promise<HeadResult> {
      try {
        const r = await fetch(await signedRead(path, 60), { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
        if (!r.ok) return { ok: false, bytes: 0, contentType: '' };
        return {
          ok: true,
          bytes: Number(r.headers.get('content-length') ?? 0),
          contentType: String(r.headers.get('content-type') ?? '').split(';')[0]!.trim(),
        };
      } catch {
        return { ok: false, bytes: 0, contentType: '' };
      }
    },

    async remove(paths: string[]): Promise<{ failed: string[] }> {
      const keys: string[] = [];
      const failed: string[] = [];
      for (const p of paths) {
        try { keys.push(assertSafeKey(p)); } catch { failed.push(p); }
      }
      // Supabase removes up to 1,000 keys a call.
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        try {
          const r = await from().remove(batch);
          if (r.error) failed.push(...batch);
        } catch {
          failed.push(...batch);
        }
      }
      return { failed };
    },

    async list(prefix: string, max = 2000): Promise<ListEntry[]> {
      // Supabase lists one folder level a page at a time, so walk it.
      const out: ListEntry[] = [];
      const queue = [trimTrailingSlashes(assertFolderPrefix(prefix))];
      let folders = 0;
      while (queue.length && out.length < max && folders < 500) {
        const dir = queue.shift() as string;
        folders += 1;
        for (let offset = 0; out.length < max; offset += 1000) {
          const { data, error } = await from().list(dir, { limit: 1000, offset });
          if (error) throw new Error(error.message);
          for (const e of data ?? []) {
            const p = dir ? `${dir}/${e.name}` : e.name;
            if (e.id == null) queue.push(p);
            else out.push({ path: p, bytes: Number(e.metadata?.size ?? 0) });
            if (out.length >= max) break;
          }
          if ((data ?? []).length < 1000) break;
        }
      }
      return out;
    },

    async copy(fromPath: string, toPath: string): Promise<void> {
      const r = await from().copy(assertSafeKey(fromPath), assertSafeKey(toPath));
      if (r.error) throw new Error(`storage copy failed: ${r.error.message}`);
    },

    async readRange(path: string, bytes: number): Promise<Buffer> {
      const r = await fetch(await signedRead(path, 60), {
        headers: { Range: `bytes=0-${Math.max(0, bytes - 1)}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`read ${r.status}`);
      return Buffer.from(await r.arrayBuffer()).subarray(0, bytes);
    },
  };
}
