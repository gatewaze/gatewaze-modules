/**
 * The storage adapter's selection logic (lib/storage.ts).
 *
 * The S3 client itself is not exercised here: these tests pin which store a
 * row or a new asset resolves to, and the refusals, because a wrong answer
 * there is a file written to one bucket and recorded against another.
 */

import { describe, it, expect } from 'vitest';
import {
  s3SettingsFromEnv, providerForNew, bucketForNew, storeFor, storeForNew, assertSafeKey, externalise,
} from '../lib/storage.js';

const S3_ENV = {
  VIDEO_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  VIDEO_S3_REGION: 'us-west-004',
  VIDEO_S3_BUCKET: 'aaif-video-masters',
  VIDEO_S3_ACCESS_KEY_ID: 'key-id',
  VIDEO_S3_SECRET_ACCESS_KEY: 'secret',
};

const fakeSupabase = { storage: { from: () => ({}) } };

describe('s3SettingsFromEnv', () => {
  it('reads all five values', () => {
    expect(s3SettingsFromEnv(S3_ENV)).toEqual({
      endpoint: S3_ENV.VIDEO_S3_ENDPOINT, region: 'us-west-004', bucket: 'aaif-video-masters',
      accessKeyId: 'key-id', secretAccessKey: 'secret',
    });
  });

  it('is null when any value is missing', () => {
    for (const k of Object.keys(S3_ENV)) {
      expect(s3SettingsFromEnv({ ...S3_ENV, [k]: '' })).toBeNull();
    }
  });

  it('refuses a non-https endpoint and a bucket name S3 would not accept', () => {
    expect(s3SettingsFromEnv({ ...S3_ENV, VIDEO_S3_ENDPOINT: 'http://s3.example' })).toBeNull();
    expect(s3SettingsFromEnv({ ...S3_ENV, VIDEO_S3_BUCKET: 'Bad Bucket/Name' })).toBeNull();
  });
});

describe('providerForNew / bucketForNew', () => {
  it('sends masters and shorts to S3 when configured, thumbnails to Supabase always', () => {
    expect(providerForNew('master', S3_ENV)).toBe('s3');
    expect(providerForNew('short', S3_ENV)).toBe('s3');
    expect(providerForNew('thumbnail', S3_ENV)).toBe('supabase');
    expect(bucketForNew('master', 's3', S3_ENV)).toBe('aaif-video-masters');
    expect(bucketForNew('thumbnail', 'supabase', S3_ENV)).toBe('media');
  });

  it('falls back to Supabase video-masters without S3', () => {
    expect(providerForNew('master', {})).toBe('supabase');
    expect(bucketForNew('master', 'supabase', {})).toBe('video-masters');
  });
});

describe('storeFor', () => {
  it('resolves an old row (no provider) to Supabase', () => {
    const s = storeFor(fakeSupabase, { storage_bucket: 'video-masters' }, S3_ENV);
    expect(s.provider).toBe('supabase');
    expect(s.bucket).toBe('video-masters');
  });

  it('resolves an s3 row to the configured bucket', () => {
    const s = storeFor(fakeSupabase, { storage_provider: 's3', storage_bucket: 'aaif-video-masters' }, S3_ENV);
    expect(s.provider).toBe('s3');
  });

  it('refuses an s3 row when S3 is not configured', () => {
    expect(() => storeFor(fakeSupabase, { storage_provider: 's3', storage_bucket: 'aaif-video-masters' }, {}))
      .toThrow(/not configured/);
  });

  it('refuses an s3 row whose bucket is not the configured one', () => {
    expect(() => storeFor(fakeSupabase, { storage_provider: 's3', storage_bucket: 'other-bucket' }, S3_ENV))
      .toThrow(/other-bucket/);
  });

  it('storeForNew picks S3 for a master and Supabase media for a thumbnail', () => {
    expect(storeForNew(fakeSupabase, 'master', S3_ENV).provider).toBe('s3');
    const thumb = storeForNew(fakeSupabase, 'thumbnail', S3_ENV);
    expect(thumb.provider).toBe('supabase');
    expect(thumb.bucket).toBe('media');
  });
});

describe('assertSafeKey', () => {
  it('accepts a normal key', () => {
    expect(assertSafeKey('agenda_entry/abc/def/talk.mp4')).toBe('agenda_entry/abc/def/talk.mp4');
  });
  it('refuses traversal, a leading slash, control characters and empties', () => {
    for (const bad of ['../x', 'a/../b', '/abs', 'a\u0000b', '']) {
      expect(() => assertSafeKey(bad)).toThrow(/unsafe/);
    }
  });
});

describe('externalise', () => {
  it('rewrites the internal Supabase host to the public one', () => {
    const env = { SUPABASE_URL: 'http://supabase-kong:8000', SUPABASE_PUBLIC_URL: 'https://data.example.com' };
    expect(externalise('http://supabase-kong:8000/storage/v1/x?token=1', env)).toBe('https://data.example.com/storage/v1/x?token=1');
    expect(externalise('https://elsewhere/x', env)).toBe('https://elsewhere/x');
  });
});
