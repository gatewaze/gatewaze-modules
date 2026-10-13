import { describe, expect, it } from 'vitest';

import {
  checkState,
  constantTimeEqual,
  safeReturnTarget,
  signState,
  STATE_TTL_MS,
  verifyState,
} from '../functions/integrations-google-sheets-oauth/oauth-state.ts';

// Test-only values, not real credentials.
const SECRET = 'test-signing-secret-a';
const OTHER_SECRET = 'test-signing-secret-b';
const T0 = 1_760_000_000_000;
const INPUT = { e: 'abc1234567', t: 'registration' as const, r: '/events/abc/integrations', u: 'user-1' };

const b64url = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

describe('signState / verifyState', () => {
  it('accepts a state it signed and returns its fields', async () => {
    const token = await signState(INPUT, SECRET, T0);
    const state = await verifyState(token, SECRET, T0 + 1000);
    expect(state).toMatchObject({ v: 1, ...INPUT, iat: T0 });
    expect(state?.n).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it('never issues the same state twice', async () => {
    expect(await signState(INPUT, SECRET, T0)).not.toBe(await signState(INPUT, SECRET, T0));
  });

  it('refuses a state signed with a different secret', async () => {
    const token = await signState(INPUT, OTHER_SECRET, T0);
    expect(await verifyState(token, SECRET, T0)).toBeNull();
  });

  it('refuses a payload changed after signing (event swapped)', async () => {
    const token = await signState(INPUT, SECRET, T0);
    const [body, sig] = token.split('.');
    const payload = JSON.parse(fromB64url(body));
    payload.e = 'victim0001';
    expect(await verifyState(`${b64url(JSON.stringify(payload))}.${sig}`, SECRET, T0)).toBeNull();
  });

  it('refuses an empty or truncated signature (the length check)', async () => {
    const token = await signState(INPUT, SECRET, T0);
    const [body, sig] = token.split('.');
    expect(await verifyState(`${body}.`, SECRET, T0)).toBeNull();
    expect(await verifyState(`${body}.${sig.slice(0, 4)}`, SECRET, T0)).toBeNull();
  });

  it('says why a state was refused, without echoing it', async () => {
    const token = await signState(INPUT, SECRET, T0);
    const [body] = token.split('.');
    expect(await checkState(token, '', T0)).toEqual({ rejected: 'no_secret' });
    expect(await checkState('abc', SECRET, T0)).toEqual({ rejected: 'malformed' });
    expect(await checkState(`${body}.AAAA`, SECRET, T0)).toEqual({ rejected: 'bad_signature' });
    expect(await checkState(token, SECRET, T0 + STATE_TTL_MS + 1)).toEqual({ rejected: 'expired' });
    expect(await checkState(token, SECRET, T0 - 5 * 60 * 1000)).toEqual({ rejected: 'issued_in_future' });
    const odd = await signState({ ...INPUT, t: 'payments' as never }, SECRET, T0);
    expect(await checkState(odd, SECRET, T0)).toEqual({ rejected: 'bad_payload' });
    expect(await checkState(token, SECRET, T0)).toMatchObject({ state: { e: INPUT.e } });
  });

  it('refuses a changed signature', async () => {
    const token = await signState(INPUT, SECRET, T0);
    const [body, sig] = token.split('.');
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(await verifyState(`${body}.${flipped}`, SECRET, T0)).toBeNull();
  });

  it('refuses a state older than the TTL and accepts one just inside it', async () => {
    const token = await signState(INPUT, SECRET, T0);
    expect(await verifyState(token, SECRET, T0 + STATE_TTL_MS)).not.toBeNull();
    expect(await verifyState(token, SECRET, T0 + STATE_TTL_MS + 1)).toBeNull();
  });

  it('refuses a state stamped in the future beyond the clock-skew allowance', async () => {
    const token = await signState(INPUT, SECRET, T0 + 5 * 60 * 1000);
    expect(await verifyState(token, SECRET, T0)).toBeNull();
  });

  it('refuses a MAC made with the right secret but without the purpose label', async () => {
    // Guards the domain separation: an HMAC of the same body under the same
    // secret, made for some other purpose, must not pass as an OAuth state.
    const { createHmac } = await import('node:crypto');
    const token = await signState(INPUT, SECRET, T0);
    const [body] = token.split('.');
    const bare = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(await verifyState(`${body}.${bare}`, SECRET, T0)).toBeNull();
  });

  it('refuses the unsigned base64 JSON state the old version issued', async () => {
    const legacy = Buffer.from(
      JSON.stringify({ eventId: 'abc', notificationType: 'registration', returnUrl: '/', redirectUri: 'x' }),
    ).toString('base64');
    expect(await verifyState(legacy, SECRET, T0)).toBeNull();
  });

  it('refuses a correctly signed payload with an unknown notification type', async () => {
    const token = await signState({ ...INPUT, t: 'payments' as never }, SECRET, T0);
    expect(await verifyState(token, SECRET, T0)).toBeNull();
  });

  it('refuses empty, missing and malformed tokens', async () => {
    for (const bad of [null, undefined, '', 'a', 'a.b.c', '.', 'not base64!.x']) {
      expect(await verifyState(bad as string, SECRET, T0)).toBeNull();
    }
  });

  it('fails closed without a secret: signing throws and nothing verifies', async () => {
    await expect(signState(INPUT, '', T0)).rejects.toThrow(/not configured/);
    const token = await signState(INPUT, SECRET, T0);
    expect(await verifyState(token, '', T0)).toBeNull();
  });
});

describe('constantTimeEqual', () => {
  it('compares bytes', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([]), new Uint8Array([1]))).toBe(false);
  });
});

describe('safeReturnTarget', () => {
  const SITE = 'https://admin.example.test';
  const OTHER_ADMIN = 'https://admin2.example.test';

  it.each([
    '/',
    '/events/abc123/integrations',
    '/events/abc123/integrations?tab=google-sheets&x=1',
    '/events/a%2Fb',
  ])('keeps the same-origin path %s', (path) => {
    expect(safeReturnTarget(path, SITE)).toBe(path);
  });

  it.each([
    ['an absolute URL elsewhere', 'https://evil.example/phish'],
    ['a protocol-relative URL', '//evil.example/phish'],
    ['a backslash host', '/\\evil.example'],
    ['a backslash anywhere', '/events\\..\\x'],
    ['a tab inside the slashes', '/\t/evil.example'],
    ['a newline', '/events\n/x'],
    ['a NUL', '/events\u0000'],
    ['a DEL', '/events\u007f'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,hi'],
    ['a bare host', 'evil.example'],
    ['a lookalike origin', 'https://admin.example.test.evil.example/'],
    ['the right host on another scheme', 'http://admin.example.test/'],
    ['the right host on another port', 'https://admin.example.test:8443/'],
    ['a userinfo trick', 'https://admin.example.test@evil.example/'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['an over-long value', '/' + 'a'.repeat(5000)],
  ])('falls back to / for %s', (_label, raw) => {
    expect(safeReturnTarget(raw, SITE)).toBe('/');
  });

  it.each([
    ['/..//evil.example', 'dot-dot then double slash'],
    ['/.//evil.example', 'dot then double slash'],
    ['/a/../..//evil.example/x', 'nested dot segments'],
  ])('refuses %s, which normalises to a protocol-relative path (%s)', (raw) => {
    expect(safeReturnTarget(raw, SITE)).toBe('/');
  });

  it('returns the normalised path, not the raw one', () => {
    expect(safeReturnTarget('/events/./abc/../xyz?tab=1#h', SITE)).toBe('/events/xyz?tab=1#h');
  });

  it('refuses an allowed absolute URL whose path starts with //', () => {
    expect(safeReturnTarget('https://admin.example.test//evil.example/', SITE)).toBe('/');
  });

  it('accepts an absolute URL on the site origin', () => {
    expect(safeReturnTarget('https://admin.example.test/events/x?y=1', SITE)).toBe(
      'https://admin.example.test/events/x?y=1',
    );
  });

  it('accepts an absolute URL on an allow-listed admin origin, and only that one', () => {
    expect(safeReturnTarget(`${OTHER_ADMIN}/events/x`, SITE, [OTHER_ADMIN])).toBe(`${OTHER_ADMIN}/events/x`);
    expect(safeReturnTarget(`${OTHER_ADMIN}/events/x`, SITE, [])).toBe('/');
    expect(safeReturnTarget(`${OTHER_ADMIN}/events/x`, SITE, [undefined, null, 'not a url'])).toBe('/');
  });

  it('falls back to / when the site URL itself is unusable', () => {
    expect(safeReturnTarget('/events/x', 'not a url')).toBe('/');
  });

  it('keeps the old landing behaviour: a path resolves onto the site origin', () => {
    const dest = new URL(safeReturnTarget('/events/abc?tab=sheets', SITE), SITE);
    expect(dest.href).toBe('https://admin.example.test/events/abc?tab=sheets');
    const evil = new URL(safeReturnTarget('https://evil.example/', SITE), SITE);
    expect(evil.origin).toBe(SITE);
  });
});
