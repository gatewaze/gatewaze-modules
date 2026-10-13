/**
 * Sealed-secret envelope for credentials this module keeps at rest.
 *
 * Mirror of the platform helper (packages/shared/src/modules/secrets.ts) and of
 * the copies in residential-egress and videos-publisher-youtube: AES-256-GCM,
 * `v1:<base64(nonce || ciphertext || tag)>`, key from GATEWAZE_SECRETS_KEY
 * (base64, 32 bytes) with GATEWAZE_SECRETS_KEY_OLD as the rotation fallback.
 * Copied rather than imported because module files are loaded in the worker
 * and API containers where @gatewaze/shared does not resolve. If the platform
 * ships a `v2:` envelope, update every copy together.
 *
 * node:crypto only, so it loads anywhere plain ESM does.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = 'v1:';

function keyFromEnv(name, env) {
  const raw = env[name];
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

/** True when the value is a sealed envelope rather than legacy plaintext. */
export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Seal a secret with the current key.
 *
 * @returns the envelope, or null when no usable key is configured — callers
 *   MUST refuse to store the secret in that case rather than fall back to
 *   plaintext.
 */
export function sealSecret(plaintext, env = process.env) {
  if (plaintext == null || plaintext === '') return null;
  const key = keyFromEnv('GATEWAZE_SECRETS_KEY', env);
  if (!key) return null;
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64');
}

/**
 * Read a stored secret.
 *
 * @returns plaintext; the value unchanged when it was never sealed (legacy
 *   rows); or null when it is sealed and no configured key opens it. Callers
 *   MUST treat null as "unavailable" and never use the raw ciphertext.
 */
export function unsealSecret(value, env = process.env) {
  if (value == null || value === '') return null;
  if (!isSealed(value)) return value;

  const combined = Buffer.from(String(value).slice(PREFIX.length), 'base64');
  if (combined.length < NONCE_LENGTH + TAG_LENGTH + 1) return null;
  const nonce = combined.subarray(0, NONCE_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const encrypted = combined.subarray(NONCE_LENGTH, combined.length - TAG_LENGTH);

  for (const name of ['GATEWAZE_SECRETS_KEY', 'GATEWAZE_SECRETS_KEY_OLD']) {
    const key = keyFromEnv(name, env);
    if (!key) continue;
    try {
      const decipher = createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key for this envelope — try the rotation fallback.
    }
  }
  return null;
}
