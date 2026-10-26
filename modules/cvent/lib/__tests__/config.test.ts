import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { parseCredentials, parseSyncSettings } from '../config';

function seal(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([nonce, enc, cipher.getAuthTag()]).toString('base64')}`;
}

describe('parseCredentials', () => {
  const saved = process.env.GATEWAZE_SECRETS_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATEWAZE_SECRETS_KEY;
    else process.env.GATEWAZE_SECRETS_KEY = saved;
  });

  it('returns null until both values are set', () => {
    expect(parseCredentials(null)).toBeNull();
    expect(parseCredentials({ CVENT_CLIENT_ID: 'id' })).toBeNull();
    expect(parseCredentials({ CVENT_CLIENT_SECRET: 's' })).toBeNull();
    expect(parseCredentials({ CVENT_CLIENT_ID: '  ', CVENT_CLIENT_SECRET: 's' })).toBeNull();
  });

  it('accepts a plaintext secret (pre-sealing rows)', () => {
    expect(parseCredentials({ CVENT_CLIENT_ID: ' id ', CVENT_CLIENT_SECRET: 'plain' })).toEqual({ clientId: 'id', clientSecret: 'plain' });
  });

  it('unseals a sealed secret with the platform key', () => {
    const key = randomBytes(32);
    process.env.GATEWAZE_SECRETS_KEY = key.toString('base64');
    expect(parseCredentials({ CVENT_CLIENT_ID: 'id', CVENT_CLIENT_SECRET: seal('s3cret', key) })).toEqual({ clientId: 'id', clientSecret: 's3cret' });
  });

  it('treats a sealed secret it cannot open as not configured, never as ciphertext', () => {
    process.env.GATEWAZE_SECRETS_KEY = randomBytes(32).toString('base64');
    const sealed = seal('s3cret', randomBytes(32));
    expect(parseCredentials({ CVENT_CLIENT_ID: 'id', CVENT_CLIENT_SECRET: sealed })).toBeNull();
  });
});

describe('parseSyncSettings', () => {
  it('uses defaults and clamps out-of-range values', () => {
    expect(parseSyncSettings(null)).toEqual({ budgetMs: 50_000, batchSize: 100, maxAttempts: 5, pauseMs: 500 });
    expect(parseSyncSettings({ budget_ms: '1', batch_size: 99999, max_attempts: 'x', pause_ms: -5 })).toEqual({
      budgetMs: 5_000,
      batchSize: 1_000,
      maxAttempts: 5,
      pauseMs: 0,
    });
  });
});
