import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { provider, r2Endpoint, r2Settings } from '../provider.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const FULL = {
  R2_ACCOUNT_ID: ACCOUNT,
  R2_BUCKET: 'media-bucket',
  R2_ACCESS_KEY_ID: 'AKID',
  R2_SECRET_ACCESS_KEY: 'SECRET',
  R2_PUBLIC_URL: 'https://media.example.com/',
};

function seal(value: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([nonce, enc, c.getAuthTag()]).toString('base64')}`;
}

afterEach(() => {
  delete process.env.GATEWAZE_SECRETS_KEY;
});

describe('r2Settings', () => {
  it('reads every setting from env', () => {
    expect(r2Settings(FULL, {})).toEqual({
      accountId: ACCOUNT, bucket: 'media-bucket', accessKeyId: 'AKID', secretAccessKey: 'SECRET',
      publicBaseUrl: 'https://media.example.com', resize: false, jurisdiction: '',
    });
  });

  it('is null until every required setting is there', () => {
    for (const k of Object.keys(FULL)) {
      const env: Record<string, string> = { ...FULL };
      delete env[k];
      expect(r2Settings(env, {})).toBeNull();
    }
  });

  it('refuses values that would reach a hostname or URL in the wrong shape', () => {
    expect(r2Settings({ ...FULL, R2_ACCOUNT_ID: 'evil.com/x' }, {})).toBeNull();
    expect(r2Settings({ ...FULL, R2_BUCKET: 'Bad_Bucket' }, {})).toBeNull();
    expect(r2Settings({ ...FULL, R2_PUBLIC_URL: 'http://media.example.com' }, {})).toBeNull();
    expect(r2Settings({ ...FULL, R2_PUBLIC_URL: 'https://media.example.com/path' }, {})).toBeNull();
    expect(r2Settings({ ...FULL, R2_JURISDICTION: 'mars' }, {})).toBeNull();
  });

  it('reads the module config, unsealing the keys', () => {
    const key = randomBytes(32);
    process.env.GATEWAZE_SECRETS_KEY = key.toString('base64');
    const cfg = { ...FULL, R2_ACCESS_KEY_ID: seal('AKID2', key), R2_SECRET_ACCESS_KEY: seal('SECRET2', key), R2_IMAGE_RESIZING: 'true' };
    const s = r2Settings({}, cfg);
    expect(s?.accessKeyId).toBe('AKID2');
    expect(s?.secretAccessKey).toBe('SECRET2');
    expect(s?.resize).toBe(true);
  });

  it('treats a key it cannot unseal as missing, never as the ciphertext', () => {
    const sealed = seal('AKID2', randomBytes(32));
    process.env.GATEWAZE_SECRETS_KEY = randomBytes(32).toString('base64');
    expect(r2Settings({}, { ...FULL, R2_ACCESS_KEY_ID: sealed })).toBeNull();
  });

  it('reads the resize switch whether it was saved as text or as a boolean', () => {
    expect(r2Settings({}, { ...FULL, R2_IMAGE_RESIZING: true })?.resize).toBe(true);
    expect(r2Settings({}, { ...FULL, R2_IMAGE_RESIZING: false })?.resize).toBe(false);
  });

  it('serves only its own bucket', () => {
    const s = r2Settings(FULL, {})!;
    expect(provider.allowedBuckets!(s)).toEqual(['media-bucket']);
  });

  it('lets env win over the module config', () => {
    expect(r2Settings({ R2_BUCKET: 'from-env' }, { ...FULL })?.bucket).toBe('from-env');
  });
});

describe('the r2 provider', () => {
  it('points at the account endpoint, with the jurisdiction when there is one', () => {
    expect(r2Endpoint({ accountId: ACCOUNT, jurisdiction: '' })).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(r2Endpoint({ accountId: ACCOUNT, jurisdiction: 'eu' })).toBe(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
  });

  it('makes a store that serves from the custom domain', () => {
    const s = r2Settings({ ...FULL, R2_IMAGE_RESIZING: 'true' }, {})!;
    const store = provider.createStore(s, provider.defaultBucket(s));
    expect([store.provider, store.bucket]).toEqual(['r2', 'media-bucket']);
    expect(store.publicUrl('event/e1/m1/a.jpg')).toBe('https://media.example.com/event/e1/m1/a.jpg');
    expect(store.sizedUrl('event/e1/m1/a.jpg', { width: 640 })).toBe(
      'https://media.example.com/cdn-cgi/image/width=640,fit=scale-down,quality=80,format=auto/event/e1/m1/a.jpg',
    );
  });
});
