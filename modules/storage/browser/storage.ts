/**
 * Storage addresses and uploads for module admin pages (browser code).
 *
 * A brand that has moved off Supabase Storage sets VITE_STORAGE_PUBLIC_URL
 * (and VITE_STORAGE_LEGACY_HOSTS) in the admin's runtime config. Then:
 *   - addresses are built on that origin (lib/public-url.ts rules), and
 *   - uploads go through the API: POST /api/storage/sign-upload returns a
 *     short-lived PUT address, which the browser uses with exactly the
 *     headers it is given; deletes go through POST /api/storage/delete.
 *     The API applies the bucket and path rules; this file decides nothing.
 * Without that setting, or when the API answers 404 not_enabled, every call
 * is the supabase-js call module pages made before.
 *
 * Browser-safe: no node imports, nothing from lib/registry (AWS SDK).
 * Module admin code imports this file relatively, because a platform admin
 * image of any age must be able to build it.
 */

import { supabase } from '@/lib/supabase';
import { rewriteStorageUrl as rewriteWith, storagePublicConfig, storagePublicUrl, type StoragePublicConfig } from '../lib/public-url';

type Env = Record<string, string | undefined>;

/** The runtime config the admin entrypoint writes, then the build-time env. */
function readEnv(): Env {
  const runtime = ((globalThis as { __GATEWAZE_CONFIG__?: Env }).__GATEWAZE_CONFIG__ ?? {}) as Env;
  // Written out in full so the admin build's runtime-config rewrite, which
  // matches `import.meta.env.VITE_*` literally, finds them.
  let built: Env = {};
  try {
    built = {
      // @ts-ignore -- Vite's ImportMeta types are not loaded in this module's tsconfig.
      VITE_STORAGE_PUBLIC_URL: import.meta.env.VITE_STORAGE_PUBLIC_URL,
      // @ts-ignore
      VITE_STORAGE_LEGACY_HOSTS: import.meta.env.VITE_STORAGE_LEGACY_HOSTS,
      // @ts-ignore
      VITE_API_URL: import.meta.env.VITE_API_URL,
    };
  } catch {
    // No build-time env (or no runtime config object behind the rewrite).
  }
  const pick = (k: string) => (runtime[k] ? String(runtime[k]) : built[k]);
  return {
    VITE_STORAGE_PUBLIC_URL: pick('VITE_STORAGE_PUBLIC_URL'),
    VITE_STORAGE_LEGACY_HOSTS: pick('VITE_STORAGE_LEGACY_HOSTS'),
    VITE_API_URL: pick('VITE_API_URL'),
  };
}

/** The brand's storage origin and old hosts; publicUrl is empty when it is still on Supabase. */
export function storageConfig(): StoragePublicConfig {
  return storagePublicConfig(readEnv(), 'VITE_');
}

function apiBase(): string {
  return String(readEnv().VITE_API_URL ?? '').replace(/\/+$/, '');
}

/** A file's public address: the brand's storage origin when configured, else Supabase's. */
export function publicStorageUrl(bucket: string, path: string): string {
  const moved = storagePublicUrl(storageConfig(), bucket, path);
  if (moved) return moved;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

/** One of this brand's old Supabase storage addresses as its new one; anything else unchanged. */
export function rewriteStorageUrl(url: string): string {
  return rewriteWith(url, storageConfig());
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.message || body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Posts to the storage API; null when the brand has not turned it on (404 not_enabled). */
async function storageApi<T>(route: 'sign-upload' | 'delete', body: unknown): Promise<T | null> {
  const res = await fetch(`${apiBase()}/api/storage/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) {
    const msg = await errorText(res);
    if (msg === 'not_enabled') return null;
    throw new Error(`storage ${route} failed: ${msg}`);
  }
  if (!res.ok) throw new Error(`storage ${route} failed: ${await errorText(res)}`);
  return (await res.json()) as T;
}

interface SignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  bucket: string;
  path: string;
  publicUrl: string;
}

async function supabaseUpload(bucket: string, path: string, file: Blob, opts: { upsert?: boolean; contentType?: string }) {
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    upsert: opts.upsert,
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
  });
  if (error) throw new Error(error.message || 'upload failed');
  return { path, publicUrl: supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl };
}

/**
 * Uploads a file. Use the returned path and address: for some folders
 * (speaker-submissions/, talks/) the server chooses the final name.
 */
export async function uploadToStorage(
  bucket: string,
  path: string,
  file: Blob,
  opts: { upsert?: boolean; contentType?: string } = {},
): Promise<{ path: string; publicUrl: string }> {
  if (!storageConfig().publicUrl) return supabaseUpload(bucket, path, file, opts);
  const contentType = opts.contentType || file.type || 'application/octet-stream';
  const signed = await storageApi<SignedUpload>('sign-upload', {
    bucket,
    path,
    contentType,
    bytes: file.size,
    upsert: opts.upsert === true,
  });
  if (!signed) return supabaseUpload(bucket, path, file, opts);
  if (!/^https:\/\//i.test(signed.url)) throw new Error('upload failed: the signed address is not https');
  const put = await fetch(signed.url, {
    method: 'PUT',
    headers: signed.headers,
    body: file,
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!put.ok) throw new Error(`upload failed: HTTP ${put.status}`);
  return { path: signed.path, publicUrl: signed.publicUrl };
}

/** Removes files. Throws when any could not be removed. */
export async function removeFromStorage(bucket: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  if (storageConfig().publicUrl) {
    const r = await storageApi<{ failed?: string[] }>('delete', { bucket, paths });
    if (r) {
      if (r.failed?.length) throw new Error(`could not remove ${r.failed.length} file(s)`);
      return;
    }
  }
  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) throw new Error(error.message || 'remove failed');
}
