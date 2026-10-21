// @ts-nocheck — supabase-js and the AWS SDK are resolved at module-host install time.

/**
 * Where a master lives, behind one interface.
 *
 * Two providers:
 *
 *   supabase   Supabase Storage, the original home. Still used for the public
 *              `media` bucket (thumbnails) and for every row written before
 *              migration 014.
 *   s3         An S3-compatible bucket, Backblaze B2 on AAIF. Chosen for
 *              masters whenever VIDEO_S3_BUCKET is set, because reading a
 *              master back out of Supabase costs $0.09/GB and the thumbnail
 *              pipeline reads every one.
 *
 * The row says which provider holds it (video_assets.storage_provider), so a
 * brand can switch providers without moving a byte: old rows keep reading from
 * Supabase, new rows write to S3. Callers never branch on the provider
 * themselves; they ask `storeFor(row)` and get the right one.
 *
 * Every operation is the smallest the callers need: a signed PUT for the
 * browser, a signed GET for playback, HEAD, delete, and a streamed PUT for the
 * import workers. There is deliberately no list, copy or rename.
 */

import { Readable } from 'node:stream';

export type StorageProvider = 'supabase' | 's3';

export interface HeadResult {
  ok: boolean;
  bytes: number;
  contentType: string;
}

export interface MasterStore {
  provider: StorageProvider;
  bucket: string;
  /**
   * A URL the browser can PUT the whole file to, with this content type and,
   * where the store can pin it, exactly this many bytes.
   */
  signUpload(path: string, mimeType: string, expiresSeconds?: number, bytes?: number): Promise<string>;
  /** A time-limited URL to read the object. */
  signRead(path: string, expiresSeconds: number): Promise<string>;
  head(path: string): Promise<HeadResult>;
  remove(path: string): Promise<void>;
  /**
   * Stream a body into the object. Never buffers the whole file: a 2GB
   * Buffer in the worker heap is how the pod would go down. With `maxBytes`
   * the stream is cut off and the write fails once that many bytes have
   * passed, so a source that lied about its size cannot fill the bucket.
   */
  putStream(path: string, body: ReadableStream | Readable, mimeType: string, maxBytes?: number): Promise<{ bytes: number }>;
  /**
   * The objects under a prefix, for adopting files that arrived outside the
   * module (a local shipper, a bulk copy). Bounded, so a mistaken prefix
   * cannot walk a whole bucket.
   */
  listPrefix(prefix: string, max?: number): Promise<Array<{ path: string; bytes: number; etag?: string }>>;
  /**
   * Copy an object to another key in the same bucket, server side. Used to
   * move an uploaded batch file out of the prefix the uploader's key can
   * still write to (and, on B2, hide), so the adopted master is ours alone.
   */
  copy(from: string, to: string, mimeType?: string, ifMatchEtag?: string): Promise<void>;
  /** The first `bytes` of an object, to sniff what it really is before trusting its name. */
  readHead(path: string, bytes: number): Promise<Buffer>;
}

/**
 * A Node stream of the body that counts bytes and destroys itself past the
 * cap. The count is what the callers record, since neither source's declared
 * length is trusted.
 */
export function countedStream(body: ReadableStream | Readable, maxBytes?: number): { stream: Readable; count: () => number } {
  const stream = typeof (body as ReadableStream).getReader === 'function'
    ? Readable.fromWeb(body as ReadableStream)
    : (body as Readable);
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (maxBytes && bytes > maxBytes) {
      stream.destroy(new Error(`source exceeded the ${(maxBytes / 1048576).toFixed(0)}MB limit`));
    }
  });
  return { stream, count: () => bytes };
}

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The S3 settings from the environment, or null when any of them is missing.
 *
 * All five or nothing. A bucket name without a key would make every mint
 * fail at sign time, which is a worse failure than falling back to Supabase.
 */
export function s3SettingsFromEnv(env: Record<string, string | undefined> = process.env): S3Settings | null {
  const endpoint = String(env.VIDEO_S3_ENDPOINT ?? '').trim();
  const region = String(env.VIDEO_S3_REGION ?? '').trim();
  const bucket = String(env.VIDEO_S3_BUCKET ?? '').trim();
  const accessKeyId = String(env.VIDEO_S3_ACCESS_KEY_ID ?? '').trim();
  const secretAccessKey = String(env.VIDEO_S3_SECRET_ACCESS_KEY ?? '').trim();
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  if (!/^https:\/\//i.test(endpoint)) return null;
  // A bucket name reaches a URL and a signed string; keep it to what S3
  // itself allows rather than trusting the environment blindly.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

/**
 * Which provider a NEW master goes to.
 *
 * S3 when configured, else Supabase. Thumbnails always go to Supabase's public
 * `media` bucket regardless, because that is what the CDN and the portal read.
 */
export function providerForNew(kind: string, env: Record<string, string | undefined> = process.env): StorageProvider {
  if (kind === 'thumbnail') return 'supabase';
  return s3SettingsFromEnv(env) ? 's3' : 'supabase';
}

/** The bucket a NEW asset of this kind lands in, for the given provider. */
export function bucketForNew(kind: string, provider: StorageProvider, env: Record<string, string | undefined> = process.env): string {
  if (provider === 's3') return s3SettingsFromEnv(env)?.bucket ?? '';
  return kind === 'thumbnail' ? 'media' : 'video-masters';
}

/**
 * A listing prefix that names a folder: a safe key ending in `/`, so
 * `local-import/` cannot also match `local-import-private/...`.
 */
export function assertFolderPrefix(prefix: string): string {
  const p = assertSafeKey(prefix);
  if (!p.endsWith('/')) throw new Error('listing prefix must end in /');
  return p;
}

/** An object key that cannot escape its prefix. */
export function assertSafeKey(path: string): string {
  const p = String(path ?? '');
  if (!p || p.length > 1024 || p.startsWith('/') || p.includes('..') || /[\x00-\x1f\x7f]/.test(p)) {
    throw new Error('unsafe storage path');
  }
  return p;
}

// ── Supabase ────────────────────────────────────────────────────────────────

/**
 * Rewrite an internal Supabase URL to the public one.
 *
 * SUPABASE_URL is often an in-cluster name (http://supabase-kong:8000) that a
 * browser cannot resolve, so a signed URL built from it is useless to the
 * editor. Same split as host-media's buildPublicUrl.
 */
export function externalise(url: string, env: Record<string, string | undefined> = process.env): string {
  const internal = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const external = (env.SUPABASE_PUBLIC_URL ?? internal).replace(/\/+$/, '');
  if (!internal || internal === external) return url;
  return url.startsWith(internal) ? external + url.slice(internal.length) : url;
}

export function supabaseStore(supabase, bucket: string): MasterStore {
  const from = () => supabase.storage.from(bucket);
  const from_ = from;
  return {
    provider: 'supabase',
    bucket,
    async signUpload(path) {
      const signed = await from().createSignedUploadUrl(assertSafeKey(path));
      if (signed.error) throw new Error(signed.error.message);
      return externalise(String(signed.data?.signedUrl ?? ''));
    },
    async signRead(path, expiresSeconds) {
      const signed = await from().createSignedUrl(assertSafeKey(path), expiresSeconds);
      if (signed.error) throw new Error(signed.error.message);
      return externalise(String(signed.data?.signedUrl ?? ''));
    },
    async head(path) {
      try {
        const signed = await from().createSignedUrl(assertSafeKey(path), 60);
        if (signed.error || !signed.data?.signedUrl) return { ok: false, bytes: 0, contentType: '' };
        const r = await fetch(signed.data.signedUrl, { method: 'HEAD' });
        if (!r.ok) return { ok: false, bytes: 0, contentType: '' };
        return {
          ok: true,
          bytes: Number(r.headers.get('content-length') ?? 0),
          contentType: String(r.headers.get('content-type') ?? '').split(';')[0].trim(),
        };
      } catch {
        return { ok: false, bytes: 0, contentType: '' };
      }
    },
    async remove(path) {
      try {
        await from().remove([assertSafeKey(path)]);
      } catch {
        /* best effort: a stray object is better than a wrong row */
      }
    },
    async putStream(path, body, mimeType, maxBytes) {
      const { stream, count } = countedStream(body, maxBytes);
      const up = await from().upload(assertSafeKey(path), stream, { contentType: mimeType, upsert: true, duplex: 'half' });
      if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);
      return { bytes: count() };
    },
    async copy(from, to) {
      const r = await from_().copy(assertSafeKey(from), assertSafeKey(to));
      if (r.error) throw new Error(`storage copy failed: ${r.error.message}`);
    },
    async readHead(path, bytes) {
      const signed = await from_().createSignedUrl(assertSafeKey(path), 60);
      if (signed.error || !signed.data?.signedUrl) throw new Error('could not sign a read');
      const r = await fetch(signed.data.signedUrl, { headers: { Range: `bytes=0-${Math.max(0, bytes - 1)}` }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`read ${r.status}`);
      return Buffer.from(await r.arrayBuffer()).subarray(0, bytes);
    },
    async listPrefix(prefix, max = 2000) {
      // Supabase lists one folder level at a time, a page at a time; walk it.
      const out: Array<{ path: string; bytes: number }> = [];
      const queue = [assertFolderPrefix(prefix).replace(/\/+$/, '')];
      let folders = 0;
      while (queue.length && out.length < max && folders < 200) {
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
  };
}

// ── S3 ──────────────────────────────────────────────────────────────────────

let s3ClientPromise: Promise<unknown> | null = null;

/**
 * One client per process, created on first use.
 *
 * Lazy so a brand without VIDEO_S3_* never loads the SDK. The two checksum
 * settings matter: SDK v3 from 3.729 adds CRC32 checksum headers to every
 * PUT by default, and Backblaze rejects them. 'WHEN_REQUIRED' sends a
 * checksum only where the operation needs one.
 */
async function s3Client(settings: S3Settings) {
  if (!s3ClientPromise) {
    s3ClientPromise = (async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      return new S3Client({
        endpoint: settings.endpoint,
        region: settings.region,
        credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    })();
  }
  return s3ClientPromise;
}

/** For tests: forget the cached client so a new endpoint takes effect. */
export function resetS3ClientForTests(): void {
  s3ClientPromise = null;
}

export function s3Store(settings: S3Settings, bucket: string = settings.bucket): MasterStore {
  return {
    provider: 's3',
    bucket,
    async signUpload(path, mimeType, expiresSeconds = 2 * 60 * 60, bytes) {
      const [{ PutObjectCommand }, { getSignedUrl }, client] = await Promise.all([
        import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner'), s3Client(settings),
      ]);
      // ContentType and ContentLength are part of the signature, so the
      // browser has to send the type and the size it was minted for. Unlike a
      // Supabase signed upload, an S3 presigned PUT can be replayed until it
      // expires; pinning the length means a replay can at most re-send the
      // same-sized file, and `complete` only accepts an asset once.
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: assertSafeKey(path),
        ContentType: mimeType,
        ...(bytes && bytes > 0 ? { ContentLength: bytes } : {}),
      });
      return getSignedUrl(client, cmd, { expiresIn: expiresSeconds });
    },
    async signRead(path, expiresSeconds) {
      const [{ GetObjectCommand }, { getSignedUrl }, client] = await Promise.all([
        import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner'), s3Client(settings),
      ]);
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: assertSafeKey(path) });
      return getSignedUrl(client, cmd, { expiresIn: expiresSeconds });
    },
    async head(path) {
      try {
        const [{ HeadObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), s3Client(settings)]);
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: assertSafeKey(path) }));
        return {
          ok: true,
          bytes: Number(r.ContentLength ?? 0),
          contentType: String(r.ContentType ?? '').split(';')[0].trim(),
        };
      } catch {
        return { ok: false, bytes: 0, contentType: '' };
      }
    },
    async remove(path) {
      try {
        const [{ DeleteObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), s3Client(settings)]);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: assertSafeKey(path) }));
      } catch {
        /* best effort */
      }
    },
    async putStream(path, body, mimeType, maxBytes) {
      const [{ Upload }, client] = await Promise.all([import('@aws-sdk/lib-storage'), s3Client(settings)]);
      const { stream, count } = countedStream(body, maxBytes);
      // 64MB parts, four in flight: 256MB of buffer at most, and a 5GB file is
      // 80 parts, well inside S3's 10,000.
      const up = new Upload({
        client,
        params: { Bucket: bucket, Key: assertSafeKey(path), Body: stream, ContentType: mimeType },
        partSize: 64 * 1024 * 1024,
        queueSize: 4,
        leavePartsOnError: false,
      });
      await up.done();
      return { bytes: count() };
    },
    async copy(from, to, mimeType, ifMatchEtag) {
      const [{ CopyObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), s3Client(settings)]);
      // Same bucket, server side: no bytes leave the store. Up to 5 GB in
      // one call on S3 and on B2; a larger master would need a multipart
      // copy, which no conference talk has needed yet. With an ETag the copy
      // is conditional, so a source replaced between the listing and the
      // copy fails rather than adopting bytes the listing never saw.
      await client.send(new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `/${bucket}/${assertSafeKey(from).split('/').map(encodeURIComponent).join('/')}`,
        Key: assertSafeKey(to),
        ...(ifMatchEtag ? { CopySourceIfMatch: ifMatchEtag } : {}),
        ...(mimeType ? { ContentType: mimeType, MetadataDirective: 'REPLACE' } : {}),
      }));
    },
    async readHead(path, bytes) {
      const [{ GetObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), s3Client(settings)]);
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: assertSafeKey(path), Range: `bytes=0-${Math.max(0, bytes - 1)}` }));
      const body = r.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) throw new Error('no body');
      return Buffer.from(await body.transformToByteArray()).subarray(0, bytes);
    },
    async listPrefix(prefix, max = 2000) {
      const [{ ListObjectsV2Command }, client] = await Promise.all([import('@aws-sdk/client-s3'), s3Client(settings)]);
      const out: Array<{ path: string; bytes: number; etag?: string }> = [];
      let token: string | undefined;
      do {
        const r = await client.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: assertFolderPrefix(prefix), ContinuationToken: token, MaxKeys: Math.min(1000, max - out.length),
        }));
        for (const o of r.Contents ?? []) {
          // The ETag names the bytes; a later upload under the same key
          // changes it, which is how a replaced file is noticed.
          if (o.Key && !o.Key.endsWith('/')) out.push({ path: o.Key, bytes: Number(o.Size ?? 0), etag: o.ETag ? String(o.ETag).replace(/"/g, '') : undefined });
        }
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token && out.length < max);
      return out;
    },
  };
}

// ── Selection ───────────────────────────────────────────────────────────────

/** The store for a NEW asset of this kind. */
export function storeForNew(supabase, kind: string, env: Record<string, string | undefined> = process.env): MasterStore {
  const provider = providerForNew(kind, env);
  if (provider === 's3') return s3Store(s3SettingsFromEnv(env) as S3Settings);
  return supabaseStore(supabase, bucketForNew(kind, 'supabase', env));
}

/**
 * The store for an EXISTING row, from its provider and bucket columns.
 *
 * An S3 row whose bucket is not the configured one is refused rather than
 * read from the configured bucket: that would be the wrong file with the
 * right name, and the row is the only record of where the bytes went.
 */
export function storeFor(
  supabase,
  row: { storage_provider?: string | null; storage_bucket: string },
  env: Record<string, string | undefined> = process.env,
): MasterStore {
  const provider = String(row.storage_provider ?? 'supabase') as StorageProvider;
  if (provider === 's3') {
    const settings = s3SettingsFromEnv(env);
    if (!settings) throw new Error('asset is on S3 but VIDEO_S3_* is not configured');
    if (settings.bucket !== row.storage_bucket) {
      throw new Error(`asset is in bucket ${row.storage_bucket}, not the configured ${settings.bucket}`);
    }
    return s3Store(settings);
  }
  return supabaseStore(supabase, row.storage_bucket);
}
