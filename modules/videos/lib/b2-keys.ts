/**
 * Backblaze's native API, for the one thing the S3 API cannot do: mint an
 * application key that is restricted to a prefix, expires, and can only
 * write and list.
 *
 * The credential behind this (VIDEO_B2_KEY_ID / VIDEO_B2_KEY) is an
 * account-level key with listKeys, writeKeys, deleteKeys and listBuckets.
 * That is a powerful key, because a key that can mint keys can mint any
 * key, so it lives on the API and the worker only, and this file is the
 * only code that uses it. Every key it mints is narrower than itself by
 * construction: one bucket, one prefix, two capabilities, a deadline.
 */

const API_BASE = 'https://api.backblazeb2.com';
const TIMEOUT_MS = 30_000;

/** What a batch key may do. No read (no downloads), no delete, no share. */
export const BATCH_KEY_CAPABILITIES = ['writeFiles', 'listFiles'] as const;

export const MAX_BATCH_DAYS = 30;

export interface B2Settings { keyId: string; key: string }

export function b2SettingsFromEnv(env: Record<string, string | undefined> = process.env): B2Settings | null {
  const keyId = String(env.VIDEO_B2_KEY_ID ?? '').trim();
  const key = String(env.VIDEO_B2_KEY ?? '').trim();
  if (!keyId || !key) return null;
  return { keyId, key };
}

export function b2KeysConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return b2SettingsFromEnv(env) !== null;
}

/** A prefix the minted key is confined to: `batches/<uuid>/`, nothing else. */
export function assertBatchPrefix(prefix: string): string {
  if (!/^batches\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/.test(prefix)) {
    throw new Error('a batch prefix must be batches/<batch id>/');
  }
  return prefix;
}

/** Days clamped to what a batch may live. */
export function batchDays(value: unknown, fallback = 7): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_BATCH_DAYS, Math.max(1, Math.round(n)));
}

interface Session { apiUrl: string; token: string; accountId: string }

async function authorize(settings: B2Settings): Promise<Session> {
  const basic = Buffer.from(`${settings.keyId}:${settings.key}`).toString('base64');
  const r = await fetch(`${API_BASE}/b2api/v3/b2_authorize_account`, {
    headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`b2 authorize failed: ${r.status}`);
  const j = (await r.json()) as { authorizationToken?: string; accountId?: string; apiInfo?: { storageApi?: { apiUrl?: string } } };
  const apiUrl = String(j.apiInfo?.storageApi?.apiUrl ?? '');
  if (!apiUrl.startsWith('https://') || !j.authorizationToken || !j.accountId) throw new Error('b2 authorize returned no session');
  return { apiUrl, token: j.authorizationToken, accountId: j.accountId };
}

async function call<T>(s: Session, name: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${s.apiUrl}/b2api/v3/${name}`, {
    method: 'POST', headers: { Authorization: s.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = String(((await r.json()) as { message?: string }).message ?? ''); } catch { /* no body */ }
    throw new Error(`b2 ${name} failed: ${r.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
  }
  return (await r.json()) as T;
}

/** The B2 bucket id for a bucket name. */
async function bucketIdFor(s: Session, bucket: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('bad bucket name');
  const j = await call<{ buckets?: Array<{ bucketId?: string; bucketName?: string }> }>(s, 'b2_list_buckets', { accountId: s.accountId, bucketName: bucket });
  const b = (j.buckets ?? []).find((x) => x.bucketName === bucket);
  if (!b?.bucketId) throw new Error(`bucket ${bucket} not found for this key`);
  return b.bucketId;
}

export interface MintedKey { keyId: string; key: string; expiresAt: string }

/**
 * Mint a batch key: one bucket, one prefix, write and list only, dead after
 * `days`. The key is returned exactly once; nothing here stores it.
 */
export async function createBatchKey(args: { bucket: string; prefix: string; days: number; name: string }, settings = b2SettingsFromEnv()): Promise<MintedKey> {
  if (!settings) throw new Error('VIDEO_B2_KEY_ID / VIDEO_B2_KEY are not configured');
  const prefix = assertBatchPrefix(args.prefix);
  const days = batchDays(args.days);
  const s = await authorize(settings);
  const bucketId = await bucketIdFor(s, args.bucket);
  const j = await call<{ applicationKeyId?: string; applicationKey?: string; expirationTimestamp?: number }>(s, 'b2_create_key', {
    accountId: s.accountId,
    capabilities: [...BATCH_KEY_CAPABILITIES],
    keyName: String(args.name).replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 100) || 'gatewaze-batch',
    validDurationInSeconds: days * 86400,
    bucketId,
    namePrefix: prefix,
  });
  if (!j.applicationKeyId || !j.applicationKey) throw new Error('b2 returned no key');
  const expiresAt = j.expirationTimestamp ? new Date(Number(j.expirationTimestamp)).toISOString() : new Date(Date.now() + days * 86400_000).toISOString();
  return { keyId: j.applicationKeyId, key: j.applicationKey, expiresAt };
}

/**
 * Delete a minted key. True when the key is gone, whether this call deleted
 * it or it was already gone (Backblaze answers 400 for an unknown key id);
 * false only when the call could not be made or Backblaze refused, which
 * the sync cron retries.
 */
export async function deleteKey(keyId: string, settings = b2SettingsFromEnv()): Promise<boolean> {
  if (!settings) return false;
  if (!/^[A-Za-z0-9]{10,64}$/.test(keyId)) return false;
  try {
    const s = await authorize(settings);
    await call(s, 'b2_delete_key', { applicationKeyId: keyId });
    return true;
  } catch (err) {
    return /failed: 400\b/.test(String((err as Error)?.message ?? ''));
  }
}
