/**
 * Egress-credential helpers for the Slack invitation worker.
 *
 * Dependency-free (node:crypto and fetch only) and kept out of the worker
 * script so the tests can import them without pulling in puppeteer.
 */

import { createDecipheriv } from 'crypto';

/**
 * Read a sealed secret from `installed_modules.config`.
 *
 * Mirrors `modules/residential-egress/lib/secret-envelope.ts` and the platform
 * helper it copies: AES-256-GCM, `v1:<base64(nonce || ciphertext || tag)>`,
 * key from GATEWAZE_SECRETS_KEY (base64, 32 bytes) with
 * GATEWAZE_SECRETS_KEY_OLD as the rotation fallback. Duplicated here rather
 * than imported because this file is plain ESM loaded by the platform worker,
 * where the TypeScript module libs are not resolvable. If the platform ships a
 * `v2:` envelope, update those files and this one together.
 *
 * @returns plaintext, the value unchanged when it is not sealed, or null when
 *   it is sealed and no configured key opens it — callers MUST treat null as
 *   "unavailable" and never fall back to the raw ciphertext.
 */
export function unsealSecret(value) {
  if (value == null || value === '') return null;
  if (!String(value).startsWith('v1:')) return value;

  const combined = Buffer.from(String(value).slice(3), 'base64');
  if (combined.length < 12 + 16 + 1) return null;
  const nonce = combined.subarray(0, 12);
  const tag = combined.subarray(combined.length - 16);
  const encrypted = combined.subarray(12, combined.length - 16);

  for (const envName of ['GATEWAZE_SECRETS_KEY', 'GATEWAZE_SECRETS_KEY_OLD']) {
    const raw = process.env[envName];
    if (!raw) continue;
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) continue;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key for this envelope — try the rotation fallback.
    }
  }
  return null;
}

/**
 * Confirm the egress proxy will actually carry traffic before draining the
 * queue. A dead proxy (expired credentials, exhausted traffic plan) makes every
 * invite fail at page load, and each failure burns a queue row — 35 were lost
 * that way on 2026-10-11 before anyone noticed. One CONNECT up front turns that
 * into a single log line with the queue left intact.
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export function checkProxy(proxyUrl, fetchImpl = fetch) {
  const u = new URL(proxyUrl);
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  return fetchImpl(`${u.protocol}//${u.host}`, {
    method: 'GET',
    headers: { 'Proxy-Authorization': `Basic ${auth}` },
    signal: AbortSignal.timeout(20000),
  }).then(
    (res) => (res.status === 407
      // The provider puts the reason in the status text (e.g. TRAFFIC_EXHAUSTED).
      ? { ok: false, detail: `proxy rejected us: 407 ${res.statusText || 'Proxy Authentication Required'}` }
      : { ok: true, detail: `proxy reachable (${res.status})` }),
    (err) => ({ ok: false, detail: `proxy unreachable: ${err.message}` }),
  );
}
