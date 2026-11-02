/**
 * Cloudflare R2 as a storage provider.
 *
 * R2 speaks S3, so the store is the storage module's S3 store pointed at
 * https://<account>.r2.cloudflarestorage.com. Browsers load files from the
 * bucket's custom domain (R2_PUBLIC_URL), and, with R2_IMAGE_RESIZING on,
 * resized pictures come from Cloudflare Image Transformations on that same
 * domain (/cdn-cgi/image/...), so nothing is resized ahead of time.
 *
 * Settings are read from env first, then from this module's row in
 * installed_modules. The two keys are secrets and are sealed at rest there.
 */

import { s3Store } from '../../storage/lib/s3-store.js';
import { isValidBucket, trimTrailingSlashes } from '../../storage/lib/keys.js';
import { unsealSecret } from '../../storage/lib/secret-envelope.js';
import type { StorageProviderModule } from '../../storage/lib/types.js';

export interface R2Settings {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  resize: boolean;
  jurisdiction: '' | 'eu' | 'fedramp';
}

function pick(env: Record<string, string | undefined>, cfg: Record<string, unknown>, key: string, secret = false): string {
  const fromEnv = String(env[key] ?? '').trim();
  if (fromEnv) return fromEnv;
  const raw = cfg[key];
  if (typeof raw === 'boolean') return String(raw);
  if (typeof raw !== 'string') return '';
  // A sealed value that cannot be unsealed reads as missing, never as ciphertext.
  return (secret ? unsealSecret(raw.trim()) ?? '' : raw).trim();
}

export function r2Settings(env: Record<string, string | undefined>, cfg: Record<string, unknown>): R2Settings | null {
  const accountId = pick(env, cfg, 'R2_ACCOUNT_ID').toLowerCase();
  const bucket = pick(env, cfg, 'R2_BUCKET');
  const accessKeyId = pick(env, cfg, 'R2_ACCESS_KEY_ID', true);
  const secretAccessKey = pick(env, cfg, 'R2_SECRET_ACCESS_KEY', true);
  const publicBaseUrl = trimTrailingSlashes(pick(env, cfg, 'R2_PUBLIC_URL'));
  const resize = pick(env, cfg, 'R2_IMAGE_RESIZING').toLowerCase() === 'true';
  const j = pick(env, cfg, 'R2_JURISDICTION').toLowerCase();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicBaseUrl) return null;
  // Each value reaches a hostname or a URL, so hold them to their real shapes.
  if (!/^[a-f0-9]{32}$/.test(accountId)) return null;
  if (!isValidBucket(bucket)) return null;
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(publicBaseUrl)) return null;
  if (j && j !== 'eu' && j !== 'fedramp') return null;
  return { accountId, bucket, accessKeyId, secretAccessKey, publicBaseUrl, resize, jurisdiction: j as R2Settings['jurisdiction'] };
}

export function r2Endpoint(s: Pick<R2Settings, 'accountId' | 'jurisdiction'>): string {
  return `https://${s.accountId}${s.jurisdiction ? `.${s.jurisdiction}` : ''}.r2.cloudflarestorage.com`;
}

export const provider: StorageProviderModule<R2Settings> = {
  id: 'r2',
  settings: r2Settings,
  defaultBucket: (s) => s.bucket,
  // One custom domain serves one bucket, so R2 rows can only be in it.
  allowedBuckets: (s) => [s.bucket],
  createStore(s, bucket) {
    return s3Store({
      provider: 'r2',
      endpoint: r2Endpoint(s),
      region: 'auto',
      accessKeyId: s.accessKeyId,
      secretAccessKey: s.secretAccessKey,
      // The custom domain serves one bucket; another bucket has no public address here.
      publicBaseUrl: s.publicBaseUrl,
      resize: s.resize ? 'cloudflare' : 'none',
    }, bucket);
  },
};
