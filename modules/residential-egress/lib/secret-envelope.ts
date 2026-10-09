/**
 * Sealed-secret envelope reader for credentials stored in
 * `installed_modules.config`.
 *
 * Mirror of the platform helper `packages/shared/src/modules/secrets.ts`:
 * AES-256-GCM, ciphertext `v1:<base64(nonce || ciphertext || tag)>`, key from
 * `GATEWAZE_SECRETS_KEY` (base64, 32 bytes) with `GATEWAZE_SECRETS_KEY_OLD`
 * as the rotation-window fallback. The `v1:` prefix versions the format, so
 * this standalone copy stays interoperable; if the platform ever ships a
 * `v2:`, update BOTH files together.
 *
 * Self-contained (node:crypto only) so reading the module's own credentials
 * needs no runtime resolution of @gatewaze/shared — this lib is loaded from
 * worker and API contexts via loadModuleSubpath, where peer-dep resolution
 * is not guaranteed.
 */

import { createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION_PREFIX = 'v1:';

/** True when the value is a sealed envelope (vs legacy plaintext). */
export function isSealed(value: string): boolean {
  return value.startsWith(VERSION_PREFIX);
}

function keyFromEnv(keyEnv: string): Buffer | null {
  const raw = process.env[keyEnv];
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

function tryDecrypt(key: Buffer, nonce: Buffer, encrypted: Buffer, tag: Buffer): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Unseal a stored secret value.
 *
 * - `null`/empty → null (not configured)
 * - plaintext (no `v1:` prefix) → returned as-is (pre-migration rows)
 * - sealed → decrypted, or null when the key is missing/wrong — callers MUST
 *   treat null as "unavailable" and never use the raw ciphertext as the value.
 */
export function unsealSecret(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (!isSealed(value)) return value;

  const combined = Buffer.from(value.slice(VERSION_PREFIX.length), 'base64');
  if (combined.length < NONCE_LENGTH + TAG_LENGTH + 1) return null;
  const nonce = combined.subarray(0, NONCE_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const encrypted = combined.subarray(NONCE_LENGTH, combined.length - TAG_LENGTH);

  for (const env of ['GATEWAZE_SECRETS_KEY', 'GATEWAZE_SECRETS_KEY_OLD']) {
    const key = keyFromEnv(env);
    if (!key) continue;
    const result = tryDecrypt(key, nonce, encrypted, tag);
    if (result !== null) return result;
  }
  return null;
}
