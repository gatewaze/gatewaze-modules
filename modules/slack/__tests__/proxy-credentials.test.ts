import { describe, it, expect, afterEach } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
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

  /** Minimal stand-in for http.request: emits the event the test asks for. */
  function fakeRequest(emit: (req: EventEmitter) => void) {
    return () => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => setImmediate(() => emit(req));
      req.destroy = () => {};
      return req;
    };
  }
  const res = (statusCode: number, statusMessage = '') =>
    Object.assign(new EventEmitter(), { statusCode, statusMessage, destroy() {} });

  it('accepts an established tunnel', async () => {
    const impl = fakeRequest((req) => req.emit('connect', res(200, 'Connection established'), { destroy() {} }));
    await expect(checkProxy(URL_, 'example.com:443', impl)).resolves.toEqual({ ok: true, detail: 'tunnel established (200)' });
  });

  // The 2026-10-11 outage: the plan was out of traffic, and the provider says
  // so in the CONNECT status line.
  it('surfaces the provider reason when the tunnel is refused', async () => {
    const impl = fakeRequest((req) => req.emit('response', res(407, 'TRAFFIC_EXHAUSTED')));
    const out = await checkProxy(URL_, 'example.com:443', impl);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('407');
    expect(out.detail).toContain('TRAFFIC_EXHAUSTED');
  });

  it('rejects a non-200 tunnel status', async () => {
    const impl = fakeRequest((req) => req.emit('connect', res(403, 'Forbidden'), { destroy() {} }));
    const out = await checkProxy(URL_, 'example.com:443', impl);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('403');
  });

  it('treats a socket error as unusable', async () => {
    const impl = fakeRequest((req) => req.emit('error', new Error('ECONNREFUSED')));
    const out = await checkProxy(URL_, 'example.com:443', impl);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('ECONNREFUSED');
  });

  it('treats a timeout as unusable', async () => {
    const impl = fakeRequest((req) => req.emit('timeout'));
    await expect(checkProxy(URL_, 'example.com:443', impl)).resolves.toEqual({ ok: false, detail: 'proxy timed out' });
  });

  it('resolves once even if several events fire', async () => {
    const impl = fakeRequest((req) => { req.emit('response', res(407, 'NOPE')); req.emit('error', new Error('late')); });
    const out = await checkProxy(URL_, 'example.com:443', impl);
    expect(out.detail).toContain('407');
  });

  it('sends percent-decoded credentials and targets the requested host', async () => {
    let opts: Record<string, any> = {};
    const impl = (o: Record<string, any>) => {
      opts = o;
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => setImmediate(() => req.emit('connect', res(200), { destroy() {} }));
      req.destroy = () => {};
      return req;
    };
    await checkProxy(URL_, 'slack.example:443', impl as never);
    expect(opts.method).toBe('CONNECT');
    expect(opts.path).toBe('slack.example:443');
    expect(opts.host).toBe('gw.example.com');
    expect(opts.port).toBe(823);
    expect(Buffer.from(String(opts.headers['Proxy-Authorization']).replace('Basic ', ''), 'base64').toString()).toBe('user@x:pa:ss');
  });

  it('reports an unparseable proxy URL instead of throwing', async () => {
    await expect(checkProxy('not a url')).resolves.toEqual({ ok: false, detail: 'proxy URL is not parseable' });
  });
});
