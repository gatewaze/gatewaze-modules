/**
 * Key and body helpers every provider shares.
 */

import { Readable } from 'node:stream';
import type { Body } from './types.js';

/** An object key that cannot escape its prefix. */
export function assertSafeKey(path: string): string {
  const p = String(path ?? '');
  // `?` and `#` would end the path inside an address built from the key.
  // eslint-disable-next-line no-control-regex
  if (!p || p.length > 1024 || p.startsWith('/') || p.includes('..') || /[\\?#\x00-\x1f\x7f]/.test(p)) {
    throw new Error('unsafe storage path');
  }
  return p;
}

/**
 * A listing prefix that names a folder: a safe key ending in `/`, so
 * `event/1/` cannot also match `event/10/...`.
 */
export function assertFolderPrefix(prefix: string): string {
  const p = assertSafeKey(prefix);
  if (!p.endsWith('/')) throw new Error('listing prefix must end in /');
  return p;
}

/** A bucket name as S3 allows it. Bucket names reach URLs and signed strings. */
export function isValidBucket(bucket: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket);
}

/** Each path segment percent-encoded, slashes kept. */
export function encodeKey(path: string): string {
  return assertSafeKey(path).split('/').map(encodeURIComponent).join('/');
}

/** `?v=` or `&v=` for a version, or nothing. */
export function versionParam(version: string | number | null | undefined, joiner: '?' | '&'): string {
  if (version === undefined || version === null || version === '') return '';
  return `${joiner}v=${encodeURIComponent(String(version))}`;
}

export function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(n) ? n : min)));
}

/**
 * A Node stream of the body that counts bytes and destroys itself past the
 * cap. The count is what callers record, since a declared length is not
 * trusted.
 */
export function countedStream(body: Readable | ReadableStream, maxBytes?: number): { stream: Readable; count: () => number } {
  const stream = typeof (body as ReadableStream).getReader === 'function'
    ? Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
    : (body as Readable);
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (maxBytes && bytes > maxBytes) {
      stream.destroy(new Error(`body exceeded the ${(maxBytes / 1048576).toFixed(0)}MB limit`));
    }
  });
  return { stream, count: () => bytes };
}

export function isBuffer(body: Body): body is Buffer | Uint8Array {
  return body instanceof Uint8Array;
}

/** A one-year cache for objects whose names never get reused. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** An hour, for objects that may be overwritten under the same name. */
export const SHORT_CACHE = 'public, max-age=3600';

/** The max-age in a Cache-Control header, in seconds, or null. */
export function maxAgeSeconds(header: string): number | null {
  const m = /(?:^|[\s,])max-age=(\d{1,10})(?:$|[\s,])/.exec(header);
  return m ? Number(m[1]) : null;
}

/** The Cache-Control a write gets when the caller does not set one. */
export function defaultCacheControl(upsert: boolean | undefined): string {
  return upsert ? SHORT_CACHE : IMMUTABLE_CACHE;
}
