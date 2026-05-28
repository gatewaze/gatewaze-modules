/**
 * Supabase Storage helpers for screenshot + artifact persistence
 * (spec §11.4.1).
 *
 * Object key format: `{api_key_id_hash}/{request_id}/{kind}.{ext}`.
 * Bucket policy: private; signed-URL TTL controlled by
 * settings.signed_url_ttl_seconds (default 600).
 *
 * Operators are responsible for provisioning the buckets ahead of
 * module enable. The bucket self-check (selfCheckBuckets) refuses
 * /readyz on permissive bucket policies.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SignedUrlArtifact {
  kind: 'signed_url';
  url: string;
  expires_at: string;
  mime_type: string;
  width?: number;
  height?: number;
}

export interface UploadInput {
  apiKeyId: string;
  requestId: string;
  bucket: string;
  fileBytes: Uint8Array;
  mimeType: string;
  /**
   * Slug for the kind of artifact: 'screenshot' | 'html' | 'markdown'.
   * Becomes part of the object path so multiple artifacts per request
   * don't collide.
   */
  kind: 'screenshot' | 'html' | 'markdown';
  ext: string; // 'png' | 'jpeg' | 'html' | 'md'
  ttlSeconds: number;
  /** Width/height for screenshots; ignored for text. */
  width?: number;
  height?: number;
}

export async function uploadAndSign(
  supabase: SupabaseClient,
  input: UploadInput,
): Promise<SignedUrlArtifact> {
  const apiKeyHash = sha256Truncated(input.apiKeyId, 12);
  const objectKey = `${apiKeyHash}/${input.requestId}/${input.kind}.${input.ext}`;
  const upload = await supabase.storage.from(input.bucket).upload(objectKey, input.fileBytes as never, {
    contentType: input.mimeType,
    upsert: false,
  });
  if (upload.error && !upload.error.message.includes('already exists')) {
    throw new Error(`upload failed: ${upload.error.message}`);
  }
  const sign = await supabase.storage
    .from(input.bucket)
    .createSignedUrl(objectKey, input.ttlSeconds);
  if (sign.error || !sign.data) {
    throw new Error(`sign failed: ${sign.error?.message ?? 'unknown'}`);
  }
  return {
    kind: 'signed_url',
    url: sign.data.signedUrl,
    expires_at: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
    mime_type: input.mimeType,
    width: input.width,
    height: input.height,
  };
}

/**
 * Per spec §11.4.1: at module init, attempt anonymous LIST and
 * unauthenticated GET against each bucket; refuse /readyz if either
 * succeeds. Returns the list of buckets that failed the check.
 *
 * For Phase 3 we expose this as a helper; the platform's /readyz
 * handler can call it on boot. We don't fail boot — operators may
 * legitimately enable the module before provisioning storage; the
 * gating is on the `signed_url` request path returning 501 if the
 * bucket is missing.
 */
export async function selfCheckBuckets(
  supabase: SupabaseClient,
  buckets: string[],
): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];
  for (const b of buckets) {
    try {
      // Use a service-role client to LIST the bucket; we expect this
      // to succeed (we have credentials). The actual security check
      // is "is the bucket publicly readable?" — which we approximate
      // by checking the bucket's `public` flag via the management API.
      const { data, error } = await supabase.storage.getBucket(b);
      if (error) {
        failures.push(`${b}: ${error.message}`);
        continue;
      }
      if (data.public) {
        // Public bucket = signed URLs aren't security-meaningful.
        failures.push(`${b}: bucket is public; must be private`);
      }
    } catch (e) {
      failures.push(`${b}: ${(e as Error).message}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

function sha256Truncated(input: string, hexChars: number): string {
  const h = createHash('sha256');
  h.update(input);
  return h.digest('hex').slice(0, hexChars);
}
