/**
 * The sealed-secret envelope (lib/secret-envelope.ts).
 *
 * This copy adds sealSecret(), which the residential-egress original does not
 * have. The format must stay byte-compatible with the platform helper, so a
 * token sealed here is readable there.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSealed, sealSecret, unsealSecret } from '../lib/secret-envelope';

const KEY = Buffer.alloc(32, 7).toString('base64');
let saved: string | undefined;

beforeEach(() => { saved = process.env.GATEWAZE_SECRETS_KEY; process.env.GATEWAZE_SECRETS_KEY = KEY; });
afterEach(() => {
  if (saved === undefined) delete process.env.GATEWAZE_SECRETS_KEY;
  else process.env.GATEWAZE_SECRETS_KEY = saved;
});

describe('sealSecret / unsealSecret', () => {
  it('round-trips a refresh token', () => {
    const token = '1//04abcDEF-ghiJKL_mnoPQR';
    const sealed = sealSecret(token)!;
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain(token);
    expect(unsealSecret(sealed)).toBe(token);
  });

  it('uses a fresh nonce, so the same token seals differently each time', () => {
    expect(sealSecret('same')).not.toBe(sealSecret('same'));
  });

  it('REFUSES to seal when no key is configured, rather than storing plaintext', () => {
    // A credential written in the clear is worse than a connect flow that
    // fails loudly, so every caller treats null as "do not store".
    delete process.env.GATEWAZE_SECRETS_KEY;
    expect(sealSecret('token')).toBeNull();
  });

  it('refuses a tampered envelope rather than returning garbage', () => {
    const sealed = sealSecret('token')!;
    const flipped = sealed.slice(0, -4) + 'AAAA';
    expect(unsealSecret(flipped)).toBeNull();
  });

  it('refuses an envelope sealed with a different key', () => {
    const sealed = sealSecret('token')!;
    process.env.GATEWAZE_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(unsealSecret(sealed)).toBeNull();
  });

  it('recognises what is sealed and what is not', () => {
    expect(isSealed(sealSecret('x')!)).toBe(true);
    expect(isSealed('plaintext')).toBe(false);
  });
});
