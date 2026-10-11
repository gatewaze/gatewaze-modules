import { describe, it, expect, afterEach } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
// @ts-expect-error — plain ESM lib, no type declarations
import { unsealSecret, checkProxy } from '../lib/proxy-credentials.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

/** Produce a `v1:` envelope the way the platform's config save route does. */
function seal(plaintext: string, key: Buffer = KEY): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64')}`;
}

const origKey = process.env.GATEWAZE_SECRETS_KEY;
const origOld = process.env.GATEWAZE_SECRETS_KEY_OLD;
afterEach(() => {
  if (origKey === undefined) delete process.env.GATEWAZE_SECRETS_KEY;
  else process.env.GATEWAZE_SECRETS_KEY = origKey;
  if (origOld === undefined) delete process.env.GATEWAZE_SECRETS_KEY_OLD;
  else process.env.GATEWAZE_SECRETS_KEY_OLD = origOld;
});

describe('unsealSecret', () => {
  it('opens an envelope with the current key', () => {
    process.env.GATEWAZE_SECRETS_KEY = KEY.toString('base64');
    expect(unsealSecret(seal('proxy-user-123'))).toBe('proxy-user-123');
  });

  it('falls back to the rotation key', () => {
    process.env.GATEWAZE_SECRETS_KEY = OTHER_KEY.toString('base64');
    process.env.GATEWAZE_SECRETS_KEY_OLD = KEY.toString('base64');
    expect(unsealSecret(seal('rotated'))).toBe('rotated');
  });

  it('passes legacy plaintext through unchanged', () => {
    process.env.GATEWAZE_SECRETS_KEY = KEY.toString('base64');
    expect(unsealSecret('plain-secret')).toBe('plain-secret');
  });

  // The 2026-10-11 incident: sealed config + a reader that did not unseal sent
  // ciphertext as the proxy password, and every invite died on a 407.
  it('returns null rather than the ciphertext when no key opens it', () => {
    process.env.GATEWAZE_SECRETS_KEY = OTHER_KEY.toString('base64');
    delete process.env.GATEWAZE_SECRETS_KEY_OLD;
    const sealed = seal('secret');
    const out = unsealSecret(sealed);
    expect(out).toBeNull();
    expect(out).not.toBe(sealed);
  });

  it('returns null when no key is configured at all', () => {
    delete process.env.GATEWAZE_SECRETS_KEY;
    delete process.env.GATEWAZE_SECRETS_KEY_OLD;
    expect(unsealSecret(seal('secret'))).toBeNull();
  });

  it('treats empty and missing values as unavailable', () => {
    expect(unsealSecret('')).toBeNull();
    expect(unsealSecret(null)).toBeNull();
    expect(unsealSecret(undefined)).toBeNull();
  });

  it('returns null for a truncated envelope instead of throwing', () => {
    process.env.GATEWAZE_SECRETS_KEY = KEY.toString('base64');
    expect(unsealSecret('v1:' + Buffer.from('short').toString('base64'))).toBeNull();
  });
});

describe('checkProxy', () => {
  const URL_ = 'http://user%40x:pa%3Ass@gw.example.com:823';

  it('reports a usable proxy', async () => {
    const fake = async () => ({ status: 200, statusText: 'OK' }) as Response;
    await expect(checkProxy(URL_, fake)).resolves.toEqual({ ok: true, detail: 'proxy reachable (200)' });
  });

  it('surfaces the provider reason on 407 so the queue is left alone', async () => {
    const fake = async () => ({ status: 407, statusText: 'TRAFFIC_EXHAUSTED' }) as Response;
    const res = await checkProxy(URL_, fake);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('TRAFFIC_EXHAUSTED');
  });

  it('treats a network failure as unusable', async () => {
    const fake = async () => { throw new Error('ECONNREFUSED'); };
    const res = await checkProxy(URL_, fake);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('ECONNREFUSED');
  });

  it('sends percent-decoded credentials in the Basic header', async () => {
    let seen = '';
    const fake = async (_u: string, init: RequestInit) => {
      seen = String((init.headers as Record<string, string>)['Proxy-Authorization']);
      return { status: 200, statusText: 'OK' } as Response;
    };
    await checkProxy(URL_, fake as unknown as typeof fetch);
    expect(Buffer.from(seen.replace('Basic ', ''), 'base64').toString()).toBe('user@x:pa:ss');
  });
});
