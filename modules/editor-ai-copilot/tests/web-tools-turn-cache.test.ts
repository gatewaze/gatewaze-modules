import { describe, expect, it } from 'vitest';
import { TurnFetchCache } from '../lib/web-tools/turn-cache.js';
import type { FetchResult } from '../lib/web-tools/types.js';

const ok = (text: string): FetchResult => ({
  ok: true,
  text,
  final_url: 'https://example.com/',
  bytes: text.length,
  mode: 'static',
});

describe('TurnFetchCache', () => {
  it('stores and retrieves entries by canonicalised URL', () => {
    const cache = new TurnFetchCache();
    cache.set('https://example.com/a', ok('hello'));
    expect(cache.has('https://example.com/a')).toBe(true);
    const r = cache.get('https://example.com/a');
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.text).toBe('hello');
  });

  it('treats tracking-only differences as the same key', () => {
    const cache = new TurnFetchCache();
    cache.set('https://example.com/a?utm_source=newsletter', ok('first'));
    expect(cache.has('https://example.com/a')).toBe(true);
    const r = cache.get('https://example.com/a?fbclid=xyz');
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.text).toBe('first');
  });

  it('treats different paths as different entries', () => {
    const cache = new TurnFetchCache();
    cache.set('https://example.com/a', ok('a'));
    cache.set('https://example.com/b', ok('b'));
    expect(cache.size()).toBe(2);
    const a = cache.get('https://example.com/a');
    const b = cache.get('https://example.com/b');
    if (a?.ok) expect(a.text).toBe('a');
    if (b?.ok) expect(b.text).toBe('b');
  });

  it('returns undefined for unknown URL', () => {
    const cache = new TurnFetchCache();
    expect(cache.get('https://nope.example/')).toBeUndefined();
  });
});
