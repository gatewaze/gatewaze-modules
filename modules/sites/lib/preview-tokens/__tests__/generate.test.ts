import { describe, expect, it } from 'vitest';
import {
  generatePreviewToken,
  hashPreviewToken,
  compareTokenHashes,
  validateTokenRecord,
  extractPreviewToken,
  PREVIEW_TOKEN_PREFIX,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
} from '../generate.js';

describe('generatePreviewToken()', () => {
  it('produces a token with the expected prefix and a SHA-256 hex hash', () => {
    const t = generatePreviewToken({ ttlSeconds: 3600 });
    expect(t.token.startsWith(PREVIEW_TOKEN_PREFIX)).toBe(true);
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    // Hash matches the cleartext.
    expect(hashPreviewToken(t.token)).toBe(t.hash);
  });

  it('honors the TTL', () => {
    const fixedNow = new Date('2026-05-01T00:00:00Z');
    const t = generatePreviewToken({
      ttlSeconds: 600,
      now: () => fixedNow,
    });
    expect(t.expiresAt).toBe('2026-05-01T00:10:00.000Z');
  });

  it('rejects ttl <= 0', () => {
    expect(() => generatePreviewToken({ ttlSeconds: 0 })).toThrow();
    expect(() => generatePreviewToken({ ttlSeconds: -1 })).toThrow();
  });

  it('rejects ttl above the hard ceiling', () => {
    expect(() =>
      generatePreviewToken({ ttlSeconds: PREVIEW_TOKEN_MAX_TTL_SECONDS + 1 }),
    ).toThrow();
    // Boundary: exactly the max is allowed.
    expect(() =>
      generatePreviewToken({ ttlSeconds: PREVIEW_TOKEN_MAX_TTL_SECONDS }),
    ).not.toThrow();
  });

  it('uses the provided random source when given', () => {
    const fixedRandom = new Uint8Array(32).fill(0xab);
    const a = generatePreviewToken({ ttlSeconds: 60, randomSource: () => fixedRandom });
    const b = generatePreviewToken({ ttlSeconds: 60, randomSource: () => fixedRandom });
    expect(a.token).toBe(b.token);
    expect(a.hash).toBe(b.hash);
  });

  it('rejects randomSource that does not produce 32 bytes', () => {
    expect(() =>
      generatePreviewToken({ ttlSeconds: 60, randomSource: () => new Uint8Array(31) }),
    ).toThrow();
  });
});

describe('compareTokenHashes()', () => {
  it('matches identical hashes', () => {
    const t = generatePreviewToken({ ttlSeconds: 60 });
    expect(compareTokenHashes(t.hash, t.hash)).toBe(true);
  });

  it('rejects different hashes', () => {
    const a = generatePreviewToken({ ttlSeconds: 60 });
    const b = generatePreviewToken({ ttlSeconds: 60 });
    expect(compareTokenHashes(a.hash, b.hash)).toBe(false);
  });

  it('rejects malformed inputs', () => {
    expect(compareTokenHashes('a', 'a')).toBe(true);
    expect(compareTokenHashes('a', 'b')).toBe(false);
    expect(compareTokenHashes('abc', 'abcd')).toBe(false); // length mismatch
    expect(compareTokenHashes(undefined as unknown as string, 'a')).toBe(false);
  });
});

describe('validateTokenRecord()', () => {
  it('accepts an unrevoked, unexpired record', () => {
    const r = validateTokenRecord({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects expired tokens', () => {
    const r = validateTokenRecord({
      expiresAt: new Date('2025-01-01T00:00:00Z').toISOString(),
      revokedAt: null,
      now: () => new Date('2026-05-01T00:00:00Z'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('expired');
  });

  it('rejects revoked tokens (even if not expired)', () => {
    const r = validateTokenRecord({
      expiresAt: new Date('2099-01-01T00:00:00Z').toISOString(),
      revokedAt: '2026-04-01T00:00:00Z',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('revoked');
  });

  it('rejects malformed expiry', () => {
    const r = validateTokenRecord({
      expiresAt: 'not a date',
      revokedAt: null,
    });
    expect(r.ok).toBe(false);
  });
});

describe('extractPreviewToken()', () => {
  it('prefers header over query when both present', () => {
    const t = generatePreviewToken({ ttlSeconds: 60 });
    expect(extractPreviewToken(t.token, 'gw_preview_other_value_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBe(t.token);
  });

  it('returns null for missing / wrong-prefix / malformed tokens', () => {
    expect(extractPreviewToken(undefined, undefined)).toBe(null);
    expect(extractPreviewToken('', '')).toBe(null);
    expect(extractPreviewToken('not-a-token', undefined)).toBe(null);
    expect(extractPreviewToken('gw_preview_short', undefined)).toBe(null);
    expect(
      extractPreviewToken('gw_preview_' + 'A'.repeat(100), undefined),
    ).toBe(null);
  });
});
