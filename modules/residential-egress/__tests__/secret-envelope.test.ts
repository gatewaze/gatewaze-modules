import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCipheriv, randomBytes } from 'crypto';
import { unsealSecret, isSealed } from '../lib/secret-envelope.js';
import { credsFromConfig, type EgressModuleConfig } from '../lib/egress.js';

// Seal a value exactly the way the platform helper does
// (packages/shared/src/modules/secrets.ts): v1:<base64(nonce || ct || tag)>.
function seal(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64');
}

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

describe('unsealSecret', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.k = process.env.GATEWAZE_SECRETS_KEY;
    saved.old = process.env.GATEWAZE_SECRETS_KEY_OLD;
    process.env.GATEWAZE_SECRETS_KEY = KEY.toString('base64');
    delete process.env.GATEWAZE_SECRETS_KEY_OLD;
  });
  afterEach(() => {
    if (saved.k == null) delete process.env.GATEWAZE_SECRETS_KEY;
    else process.env.GATEWAZE_SECRETS_KEY = saved.k;
    if (saved.old == null) delete process.env.GATEWAZE_SECRETS_KEY_OLD;
    else process.env.GATEWAZE_SECRETS_KEY_OLD = saved.old;
  });

  it('passes legacy plaintext through unchanged', () => {
    expect(unsealSecret('plain-password')).toBe('plain-password');
    expect(isSealed('plain-password')).toBe(false);
  });

  it('returns null for empty/missing values', () => {
    expect(unsealSecret(null)).toBeNull();
    expect(unsealSecret(undefined)).toBeNull();
    expect(unsealSecret('')).toBeNull();
  });

  it('decrypts a sealed value under the current key', () => {
    const sealed = seal('s3cret!', KEY);
    expect(isSealed(sealed)).toBe(true);
    expect(unsealSecret(sealed)).toBe('s3cret!');
  });

  it('falls back to GATEWAZE_SECRETS_KEY_OLD during rotation', () => {
    const sealed = seal('rotated', OTHER_KEY);
    expect(unsealSecret(sealed)).toBeNull(); // wrong current key, no old key
    process.env.GATEWAZE_SECRETS_KEY_OLD = OTHER_KEY.toString('base64');
    expect(unsealSecret(sealed)).toBe('rotated');
  });

  it('returns null (never the ciphertext) when the key is missing or wrong', () => {
    const sealed = seal('s3cret!', OTHER_KEY);
    expect(unsealSecret(sealed)).toBeNull();
    delete process.env.GATEWAZE_SECRETS_KEY;
    expect(unsealSecret(sealed)).toBeNull();
  });

  it('returns null on truncated/garbage envelopes', () => {
    expect(unsealSecret('v1:')).toBeNull();
    expect(unsealSecret('v1:AAAA')).toBeNull();
    expect(unsealSecret('v1:not-base64!!!')).toBeNull();
  });
});

describe('credsFromConfig with sealed credentials', () => {
  const saved: string | undefined = process.env.GATEWAZE_SECRETS_KEY;
  beforeEach(() => {
    process.env.GATEWAZE_SECRETS_KEY = KEY.toString('base64');
  });
  afterEach(() => {
    if (saved == null) delete process.env.GATEWAZE_SECRETS_KEY;
    else process.env.GATEWAZE_SECRETS_KEY = saved;
  });

  const base: EgressModuleConfig = { provider: 'dataimpulse' };

  it('unseals sealed username+password into ProxyCreds', () => {
    const creds = credsFromConfig({
      ...base,
      proxy_username: seal('user-1', KEY),
      proxy_password: seal('pw-1', KEY),
    });
    expect(creds).toMatchObject({ username: 'user-1', password: 'pw-1' });
  });

  it('still accepts legacy plaintext credentials (pre-migration rows)', () => {
    const creds = credsFromConfig({ ...base, proxy_username: 'u', proxy_password: 'p' });
    expect(creds).toMatchObject({ username: 'u', password: 'p' });
  });

  it('returns null — never ciphertext — when unsealing fails', () => {
    const creds = credsFromConfig({
      ...base,
      proxy_username: seal('user-1', OTHER_KEY),
      proxy_password: seal('pw-1', OTHER_KEY),
    });
    expect(creds).toBeNull();
  });
});
