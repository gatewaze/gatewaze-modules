/**
 * Application-layer encryption for webhook URLs + secrets (spec §10.5).
 *
 * Uses AES-256-GCM with `TASKS_WEBHOOK_ENCRYPTION_KEY`. When the key
 * is unset, encryption is a no-op (degraded mode for self-host
 * operators who haven't configured a key) and a one-shot warning is
 * logged at boot.
 *
 * Encrypted payload format: base64( v01 || nonce(12) || ciphertext || tag(16) )
 * Prefix `v01` lets us roll keys / algorithms by writing v02 later.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

const VERSION = 'v01';
const ALGO = 'aes-256-gcm';

let _warnedDegraded = false;

function getKey(): Buffer | null {
  const raw = process.env.TASKS_WEBHOOK_ENCRYPTION_KEY;
  if (!raw) {
    if (!_warnedDegraded) {
      _warnedDegraded = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[tasks] TASKS_WEBHOOK_ENCRYPTION_KEY not set; webhook URL + secret stored in plaintext (degraded mode). See spec §10.5.',
      );
    }
    return null;
  }
  // Accept hex (64 chars), base64 (44+ chars), or raw 32-byte string.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  if (raw.length >= 32) return Buffer.from(raw.slice(0, 32), 'utf-8');
  // base64
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length >= 32) return buf.subarray(0, 32);
  } catch {
    /* fall through */
  }
  return Buffer.from(raw.padEnd(32, '\0').slice(0, 32), 'utf-8');
}

export function isEnabled(): boolean {
  return getKey() !== null;
}

export function encrypt(plain: string | null): string | null {
  if (plain === null || plain === '') return plain;
  const key = getKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, ct, tag]).toString('base64')}`;
}

export function decrypt(cipherText: string | null): string | null {
  if (cipherText === null) return null;
  if (!cipherText.startsWith(`${VERSION}.`)) {
    // Plaintext (legacy or degraded mode). Pass through.
    return cipherText;
  }
  const key = getKey();
  if (!key) {
    throw new Error(
      'tasks: encrypted webhook value found but TASKS_WEBHOOK_ENCRYPTION_KEY is not set',
    );
  }
  const buf = Buffer.from(cipherText.slice(VERSION.length + 1), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}

/**
 * Redact a webhook URL for safe rendering in admin lists (spec §6.13
 * WebhookSummary). Replaces the last path segment with `****` for
 * slack/discord, replaces any path segment longer than 24 chars for
 * generic URLs.
 */
export function redactUrl(url: string, kind: 'slack' | 'discord' | 'generic'): string {
  try {
    const u = new URL(url);
    if (kind === 'slack' || kind === 'discord') {
      const parts = u.pathname.split('/');
      if (parts.length > 1) {
        parts[parts.length - 1] = '****';
      }
      u.pathname = parts.join('/');
    } else {
      const parts = u.pathname.split('/').map(p => (p.length > 24 ? '****' : p));
      u.pathname = parts.join('/');
    }
    return u.toString();
  } catch {
    return '****';
  }
}
