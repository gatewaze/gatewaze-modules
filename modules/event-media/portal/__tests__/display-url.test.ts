// @ts-nocheck — vitest harness.

/**
 * The projector must never turn a CDN URL into a Supabase render path.
 * It would still display — Bunny proxies it straight back — so nothing
 * looks wrong, but every slide is billed as a Supabase transformation,
 * which is exactly the cost the CDN is there to remove.
 */

import { describe, it, expect } from 'vitest';
import { sizedDisplayUrl } from '../event-pages/_components/_lib/display-url.js';

const SB = 'https://project.supabase.co/storage/v1/object/public/media/event/e/m/img.jpeg';
const CDN = 'https://zone.b-cdn.net/storage/v1/object/public/media/event/e/m/img.jpeg';

describe('sizedDisplayUrl', () => {
  // Unchanged behaviour while no CDN is configured.
  it('resizes a Supabase original through the render endpoint, as before', () => {
    expect(sizedDisplayUrl(SB, 1920, 1080)).toBe(
      'https://project.supabase.co/storage/v1/render/image/public/media/event/e/m/img.jpeg'
      + '?width=1920&height=1080&resize=contain&quality=82',
    );
  });

  it('resizes a CDN original with CDN parameters on the plain object', () => {
    expect(sizedDisplayUrl(CDN, 1920, 1080)).toBe(`${CDN}?width=1920&height=1080&quality=82`);
  });

  it('never sends a CDN photo to the render endpoint', () => {
    const url = sizedDisplayUrl(CDN, 3840, 2160);
    expect(url).not.toContain('/render/image/');
    expect(url).not.toContain('resize=contain');
  });

  it('leaves anything it does not recognise alone', () => {
    expect(sizedDisplayUrl('https://other.example/a.jpg', 100, 100)).toBe('https://other.example/a.jpg');
    expect(sizedDisplayUrl('not a url /object/public/x', 100, 100)).toBe('not a url /object/public/x');
  });

  it('clamps the requested size', () => {
    expect(sizedDisplayUrl(CDN, 99999, 1, 500)).toContain('width=4096&height=16&quality=100');
  });
});
