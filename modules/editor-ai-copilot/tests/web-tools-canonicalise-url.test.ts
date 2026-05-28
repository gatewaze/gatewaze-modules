import { describe, expect, it } from 'vitest';
import { canonicaliseUrl } from '../lib/web-tools/canonicalise-url.js';

describe('canonicaliseUrl', () => {
  it('lowercases scheme and host but preserves path case', () => {
    expect(canonicaliseUrl('HTTPS://Example.COM/Path/To/Item')).toBe(
      'https://example.com/Path/To/Item',
    );
  });

  it('strips :443 default https port', () => {
    expect(canonicaliseUrl('https://example.com:443/x')).toBe('https://example.com/x');
  });

  it('strips tracking parameters', () => {
    const r = canonicaliseUrl('https://example.com/x?utm_source=newsletter&utm_medium=email&id=5');
    expect(r).toBe('https://example.com/x?id=5');
  });

  it('sorts query params alphabetically', () => {
    const r = canonicaliseUrl('https://example.com/x?z=1&a=2&m=3');
    expect(r).toBe('https://example.com/x?a=2&m=3&z=1');
  });

  it('drops the fragment', () => {
    expect(canonicaliseUrl('https://example.com/x#section')).toBe('https://example.com/x');
  });

  it('two URLs differing only in tracking + order canonicalise to the same string', () => {
    const a = canonicaliseUrl('https://Example.com/path?utm_source=x&id=10&utm_campaign=y');
    const b = canonicaliseUrl('https://example.com/path?id=10&fbclid=abc');
    expect(a).toBe(b);
  });

  it('returns trimmed raw for malformed URL', () => {
    expect(canonicaliseUrl('   not a url  ')).toBe('not a url');
  });
});
