/**
 * Any S3-compatible bucket as a provider: Cloudflare R2, Backblaze B2, AWS S3,
 * MinIO. Provider modules (storage-r2, ...) turn their own settings into
 * S3StoreSettings and call s3Store.
 *
 * The AWS SDK is imported lazily, so a brand that only uses Supabase never
 * loads it. The packages are dependencies of the provider modules.
 */

import { assertFolderPrefix, assertSafeKey, clampInt, countedStream, defaultCacheControl, encodeKey, isBuffer, trimTrailingSlashes, versionParam } from './keys.js';
import type { Body, HeadResult, ImageSize, ListEntry, ObjectStore, PutOptions, SignedUpload, SignUploadOptions, UrlOptions } from './types.js';

export interface S3StoreSettings {
  /** The provider id the store reports, e.g. 'r2'. */
  provider: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Where browsers load public objects from, e.g. https://media.example.com. No trailing slash. */
  publicBaseUrl: string;
  /**
   * How sizedUrl resizes:
   *   'cloudflare'  /cdn-cgi/image/<options>/<key> on publicBaseUrl, which
   *                 must be a hostname Cloudflare serves with Image
   *                 Transformations turned on for its zone.
   *   'none'        the original.
   */
  resize: 'cloudflare' | 'none';
}

type Sdk = typeof import('@aws-sdk/client-s3');

const clients = new Map<string, Promise<{ sdk: Sdk; client: InstanceType<Sdk['S3Client']> }>>();

/**
 * One client per endpoint and key, created on first use.
 *
 * The checksum settings matter: SDK v3 from 3.729 adds CRC32 checksum
 * headers to every PUT by default, which R2 and B2 have both rejected.
 * 'WHEN_REQUIRED' sends a checksum only where the operation needs one.
 */
function clientFor(s: S3StoreSettings) {
  const key = `${s.endpoint}|${s.region}|${s.accessKeyId}`;
  let p = clients.get(key);
  if (!p) {
    p = (async () => {
      const sdk = await import('@aws-sdk/client-s3');
      const client = new sdk.S3Client({
        endpoint: s.endpoint,
        region: s.region,
        credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        // Without these a stalled connection holds the request forever.
        // requestTimeout is the socket's idle time, so a long upload that
        // keeps sending is not cut off.
        requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000 },
      });
      return { sdk, client };
    })();
    // A failed import must not stay cached.
    p.catch(() => clients.delete(key));
    clients.set(key, p);
  }
  return p;
}

/** For tests: forget cached clients. */
export function resetS3ClientsForTests(): void {
  clients.clear();
}

async function presign(client: unknown, command: unknown, expiresIn: number, signContentType = false): Promise<string> {
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  return getSignedUrl(client as Parameters<typeof getSignedUrl>[0], command as Parameters<typeof getSignedUrl>[1], {
    expiresIn,
    // The presigner leaves Content-Type out of the signature unless told,
    // and then anyone holding the URL could store HTML under a .jpg name
    // and have the public domain serve it.
    ...(signContentType ? { signableHeaders: new Set(['content-type']) } : {}),
  });
}

/** Cloudflare's image options, in the order its docs write them. */
export function cloudflareImageOptions(size: ImageSize): string {
  const parts = [`width=${clampInt(size.width, 16, 4096)}`];
  if (size.height) parts.push(`height=${clampInt(size.height, 16, 4096)}`);
  parts.push(`fit=${size.fit === 'cover' ? 'cover' : 'scale-down'}`);
  parts.push(`quality=${clampInt(size.quality ?? 80, 1, 100)}`);
  parts.push('format=auto');
  return parts.join(',');
}

export function s3Store(settings: S3StoreSettings, bucket: string): ObjectStore {
  const base = trimTrailingSlashes(settings.publicBaseUrl);

  return {
    provider: settings.provider,
    bucket,
    canResize: settings.resize === 'cloudflare',

    publicUrl(path: string, opts?: UrlOptions): string {
      return `${base}/${encodeKey(path)}${versionParam(opts?.version, '?')}`;
    },

    sizedUrl(path: string, size: ImageSize, opts?: UrlOptions): string {
      if (settings.resize !== 'cloudflare') return this.publicUrl(path, opts);
      // A relative source path keeps the resize on the same zone, so it
      // cannot be pointed at another site.
      return `${base}/cdn-cgi/image/${cloudflareImageOptions(size)}/${encodeKey(path)}${versionParam(opts?.version, '?')}`;
    },

    async put(path: string, body: Body, opts: PutOptions): Promise<{ bytes: number }> {
      const key = assertSafeKey(path);
      const { sdk, client } = await clientFor(settings);
      if (!opts.upsert) {
        // S3 has no "fail if it exists" on a plain PUT that every provider
        // honours, so check first. A race here only means two writers chose
        // the same name, which the UUID-prefixed paths make unlikely.
        if ((await this.head(key)).ok) throw new Error('storage upload failed: the object already exists');
      }
      const params = { Bucket: bucket, Key: key, ContentType: opts.contentType, CacheControl: opts.cacheControl ?? defaultCacheControl(opts.upsert) };
      if (isBuffer(body)) {
        if (opts.maxBytes && body.byteLength > opts.maxBytes) throw new Error('body is over the size limit');
        await client.send(new sdk.PutObjectCommand({ ...params, Body: body, ContentLength: body.byteLength }));
        return { bytes: body.byteLength };
      }
      const { Upload } = await import('@aws-sdk/lib-storage');
      const { stream, count } = countedStream(body, opts.maxBytes);
      // 64MB parts, four in flight: 256MB of buffer at most, and a 5GB file is
      // 80 parts, well inside S3's 10,000.
      await new Upload({ client, params: { ...params, Body: stream }, partSize: 64 * 1024 * 1024, queueSize: 4, leavePartsOnError: false }).done();
      return { bytes: count() };
    },

    async signUpload(path: string, opts: SignUploadOptions): Promise<SignedUpload> {
      const { sdk, client } = await clientFor(settings);
      // ContentType and ContentLength are signed, so the browser must send
      // exactly the type and size it asked for. A presigned PUT can be
      // replayed until it expires, so keep the expiry short and pin the size.
      // Callers still check the stored object with head() afterwards.
      const cmd = new sdk.PutObjectCommand({
        Bucket: bucket,
        Key: assertSafeKey(path),
        ContentType: opts.contentType,
        ...(opts.bytes && opts.bytes > 0 ? { ContentLength: opts.bytes } : {}),
      });
      const url = await presign(client, cmd, clampInt(opts.expiresSeconds ?? 15 * 60, 60, 2 * 60 * 60), true);
      return { url, method: 'PUT', headers: { 'content-type': opts.contentType } };
    },

    async signRead(path: string, expiresSeconds: number): Promise<string> {
      const { sdk, client } = await clientFor(settings);
      return presign(client, new sdk.GetObjectCommand({ Bucket: bucket, Key: assertSafeKey(path) }), clampInt(expiresSeconds, 1, 7 * 24 * 60 * 60));
    },

    async head(path: string): Promise<HeadResult> {
      try {
        const { sdk, client } = await clientFor(settings);
        const r = await client.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: assertSafeKey(path) }));
        return { ok: true, bytes: Number(r.ContentLength ?? 0), contentType: String(r.ContentType ?? '').split(';')[0]!.trim() };
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
      if (!keys.length) return { failed };
      let sdk: Sdk; let client: InstanceType<Sdk['S3Client']>;
      try {
        ({ sdk, client } = await clientFor(settings));
      } catch {
        return { failed: [...failed, ...keys] };
      }
      // DeleteObjects takes up to 1,000 keys and reports each failure.
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        try {
          const r = await client.send(new sdk.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
          for (const e of r.Errors ?? []) if (e.Key) failed.push(e.Key);
        } catch {
          failed.push(...batch);
        }
      }
      return { failed };
    },

    async list(prefix: string, max = 2000): Promise<ListEntry[]> {
      const { sdk, client } = await clientFor(settings);
      const out: ListEntry[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new sdk.ListObjectsV2Command({
          Bucket: bucket, Prefix: assertFolderPrefix(prefix), ContinuationToken: token, MaxKeys: Math.min(1000, max - out.length),
        }));
        for (const o of r.Contents ?? []) {
          if (o.Key && !o.Key.endsWith('/')) out.push({ path: o.Key, bytes: Number(o.Size ?? 0), etag: o.ETag ? String(o.ETag).replace(/"/g, '') : undefined });
        }
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token && out.length < max);
      return out;
    },

    async copy(fromPath: string, toPath: string, opts?: { contentType?: string }): Promise<void> {
      const { sdk, client } = await clientFor(settings);
      await client.send(new sdk.CopyObjectCommand({
        Bucket: bucket,
        CopySource: `/${bucket}/${encodeKey(fromPath)}`,
        Key: assertSafeKey(toPath),
        ...(opts?.contentType ? { ContentType: opts.contentType, MetadataDirective: 'REPLACE' as const } : {}),
      }));
    },

    async readRange(path: string, bytes: number): Promise<Buffer> {
      const { sdk, client } = await clientFor(settings);
      const r = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: assertSafeKey(path), Range: `bytes=0-${Math.max(0, bytes - 1)}` }));
      const body = r.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) throw new Error('no body');
      return Buffer.from(await body.transformToByteArray()).subarray(0, bytes);
    },
  };
}
