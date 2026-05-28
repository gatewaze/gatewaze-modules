/**
 * Unit tests for URL normalization (spec §10.4).
 */

import { describe, it, expect } from 'vitest';
import { parseAndNormalize, redactQueryParams, InvalidUrlError } from '../lib/normalize.js';

describe('parseAndNormalize', () => {
  it('lowercases scheme + host', () => {
    const u = parseAndNormalize('HTTPS://Example.COM/Path');
    expect(u.scheme).toBe('https');
    expect(u.host).toBe('example.com');
    expect(u.path).toBe('/Path'); // path is case-sensitive
  });

  it('strips default ports', () => {
    expect(parseAndNormalize('http://example.com:80/').port).toBeNull();
    expect(parseAndNormalize('https://example.com:443/').port).toBeNull();
    expect(parseAndNormalize('https://example.com:8443/').port).toBe(8443);
  });

  it('strips trailing dot from host', () => {
    expect(parseAndNormalize('https://example.com./').host).toBe('example.com');
  });

  it('strips fragment', () => {
    expect(parseAndNormalize('https://example.com/p#frag').href).toBe(
      'https://example.com/p',
    );
  });

  it('rejects userinfo (credentials in URL)', () => {
    expect(() => parseAndNormalize('https://user:pass@example.com/')).toThrow(
      InvalidUrlError,
    );
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => parseAndNormalize('ftp://example.com/')).toThrow(InvalidUrlError);
    expect(() => parseAndNormalize('javascript:alert(1)')).toThrow(InvalidUrlError);
  });

  it('rejects oversized URLs', () => {
    const long = 'https://example.com/' + 'a'.repeat(2050);
    expect(() => parseAndNormalize(long)).toThrow(InvalidUrlError);
  });

  it('returns the same canonical href for trailing-dot variants', () => {
    expect(parseAndNormalize('https://example.com/').href).toBe(
      parseAndNormalize('https://example.com./').href,
    );
  });

  it('IDN domain converts to punycode', () => {
    const u = parseAndNormalize('https://bücher.example/');
    expect(u.host.startsWith('xn--')).toBe(true);
  });
});

describe('redactQueryParams', () => {
  it('replaces matching keys with REDACTED', () => {
    const r = redactQueryParams('https://example.com/?token=secret&q=foo', ['token']);
    expect(r).toContain('token=REDACTED');
    expect(r).toContain('q=foo');
  });

  it('is case-insensitive on keys', () => {
    const r = redactQueryParams('https://example.com/?Token=secret', ['token']);
    expect(r).toContain('Token=REDACTED');
  });

  it('passes through URLs with no matching keys', () => {
    const r = redactQueryParams('https://example.com/?q=foo', ['token']);
    expect(r).toContain('q=foo');
  });
});
