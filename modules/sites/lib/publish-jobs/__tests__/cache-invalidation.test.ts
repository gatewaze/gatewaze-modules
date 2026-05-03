import { describe, expect, it } from 'vitest';
import {
  buildInvalidationMessage,
  isValidInvalidationMessage,
  cacheKeyForRoute,
  CACHE_INVALIDATION_CHANNEL,
} from '../cache-invalidation.js';

describe('buildInvalidationMessage()', () => {
  it('produces a well-formed message', () => {
    const fixedTs = new Date('2026-05-01T14:30:22Z');
    const msg = buildInvalidationMessage({
      siteId: 'site-uuid',
      route: '/about',
      publishedVersion: 7,
      now: () => fixedTs,
    });
    expect(msg).toEqual({
      site_id: 'site-uuid',
      route: '/about',
      published_version: 7,
      ts: '2026-05-01T14:30:22.000Z',
    });
  });

  it('rejects empty siteId', () => {
    expect(() =>
      buildInvalidationMessage({ siteId: '', route: '/x', publishedVersion: 1 }),
    ).toThrow(/siteId required/);
  });

  it('rejects routes that do not start with /', () => {
    expect(() =>
      buildInvalidationMessage({ siteId: 'a', route: 'about', publishedVersion: 1 }),
    ).toThrow(/route must start with/);
  });

  it('rejects non-positive publishedVersion', () => {
    expect(() =>
      buildInvalidationMessage({ siteId: 'a', route: '/', publishedVersion: 0 }),
    ).toThrow(/positive integer/);
    expect(() =>
      buildInvalidationMessage({ siteId: 'a', route: '/', publishedVersion: -1 }),
    ).toThrow(/positive integer/);
  });

  it('rejects non-integer publishedVersion', () => {
    expect(() =>
      buildInvalidationMessage({ siteId: 'a', route: '/', publishedVersion: 1.5 }),
    ).toThrow(/positive integer/);
  });
});

describe('isValidInvalidationMessage()', () => {
  it('accepts a well-formed message', () => {
    expect(
      isValidInvalidationMessage({
        site_id: 'a',
        route: '/x',
        published_version: 1,
        ts: '2026-05-01T00:00:00Z',
      }),
    ).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isValidInvalidationMessage(null)).toBe(false);
    expect(isValidInvalidationMessage('not an object')).toBe(false);
    expect(isValidInvalidationMessage({})).toBe(false);
    expect(
      isValidInvalidationMessage({ site_id: '', route: '/x', published_version: 1, ts: 'now' }),
    ).toBe(false);
    expect(
      isValidInvalidationMessage({ site_id: 'a', route: 'x', published_version: 1, ts: 'now' }),
    ).toBe(false);
    expect(
      isValidInvalidationMessage({ site_id: 'a', route: '/x', published_version: 0, ts: 'now' }),
    ).toBe(false);
    expect(
      isValidInvalidationMessage({ site_id: 'a', route: '/x', published_version: 1.5, ts: 'now' }),
    ).toBe(false);
  });
});

describe('cacheKeyForRoute()', () => {
  it('formats the cache key as siteId:route', () => {
    expect(cacheKeyForRoute('aaif', '/for/developer')).toBe('aaif:/for/developer');
  });
});

describe('CACHE_INVALIDATION_CHANNEL', () => {
  it("is the spec-stipulated channel name", () => {
    expect(CACHE_INVALIDATION_CHANNEL).toBe('sites.runtime.invalidate');
  });
});
