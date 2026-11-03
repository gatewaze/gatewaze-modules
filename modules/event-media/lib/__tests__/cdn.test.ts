import { describe, it, expect } from 'vitest';
import { browserObjectUrl, browserSizedUrl, cdnConfigFromEnv } from '../cdn.js';

const SB = 'https://project.supabase.co';
const PATH = 'event/e1/m1/img-3539.jpeg';

describe('cdnConfigFromEnv', () => {
  it('is off unless explicitly enabled', () => {
    expect(cdnConfigFromEnv({}).zone).toBeNull();
    expect(cdnConfigFromEnv({ BUNNY_PULLZONE_URL: 'https://z.b-cdn.net' }).zone).toBeNull();
    expect(cdnConfigFromEnv({ BUNNY_PULLZONE_URL: 'https://z.b-cdn.net', BUNNY_CDN_ENABLED: 'false' }).zone).toBeNull();
  });

  it('turns on with an https zone and trims the trailing slash', () => {
    expect(cdnConfigFromEnv({ BUNNY_PULLZONE_URL: 'https://z.b-cdn.net/', BUNNY_CDN_ENABLED: 'true' }).zone)
      .toBe('https://z.b-cdn.net');
  });

  // A bad value must fail closed to Supabase. Sending every photo to a
  // host that does not resolve would blank the projector.
  it('refuses anything that is not a bare https origin', () => {
    for (const bad of ['http://z.b-cdn.net', 'z.b-cdn.net', 'https://z.b-cdn.net/path', 'https://', '']) {
      expect(cdnConfigFromEnv({ BUNNY_PULLZONE_URL: bad, BUNNY_CDN_ENABLED: 'true' }).zone).toBeNull();
    }
  });
});

describe('with the CDN off', () => {
  const off = { zone: null };

  // The invariant that makes this safe to deploy: output is exactly what
  // the code produced before the CDN existed.
  it('produces the same original URL as before', () => {
    expect(browserObjectUrl(off, SB, 'media', PATH))
      .toBe(`${SB}/storage/v1/object/public/media/${PATH}`);
  });

  it('produces the same resized URL as before', () => {
    expect(browserSizedUrl(off, SB, 'media', PATH, 800))
      .toBe(`${SB}/storage/v1/render/image/public/media/${PATH}?width=800&resize=contain&quality=80`);
  });
});

describe('with the CDN on', () => {
  const on = { zone: 'https://z.b-cdn.net' };

  it('fetches originals through the zone', () => {
    expect(browserObjectUrl(on, SB, 'media', PATH))
      .toBe(`https://z.b-cdn.net/storage/v1/object/public/media/${PATH}`);
  });

  // The whole point: Supabase's render endpoint is never touched, because
  // Bunny resizes the plain object instead.
  it('never routes a resize to the Supabase render endpoint', () => {
    const url = browserSizedUrl(on, SB, 'media', PATH, 1920, 82);
    expect(url).toBe(`https://z.b-cdn.net/storage/v1/object/public/media/${PATH}?width=1920&quality=82`);
    expect(url).not.toContain('/render/image/');
    expect(url).not.toContain('supabase.co');
  });

  it('clamps width and quality into range', () => {
    expect(browserSizedUrl(on, SB, 'media', PATH, 99999, 500)).toContain('width=4096&quality=100');
    expect(browserSizedUrl(on, SB, 'media', PATH, 1, 0)).toContain('width=16&quality=1');
  });
});
