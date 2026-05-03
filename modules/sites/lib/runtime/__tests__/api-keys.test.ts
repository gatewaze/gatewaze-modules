import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  generateRuntimeApiKey,
  hashRuntimeApiKey,
  compareKeyHashes,
  extractBearerKey,
  siteIdShortFromKey,
} from '../api-keys.js';

const PEPPER = randomBytes(32);

describe('generateRuntimeApiKey()', () => {
  it('produces a key with the correct prefix and a 64-char hash', () => {
    const result = generateRuntimeApiKey({ siteIdShort: 'a1b2c3d4', pepper: PEPPER });
    expect(result.cleartext.startsWith('gw_runtime_a1b2c3d4_')).toBe(true);
    expect(result.prefix).toBe('gw_runtime_a1b2c3d4_');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two generations produce different cleartext (sufficient randomness)', () => {
    const a = generateRuntimeApiKey({ siteIdShort: 'a1b2c3d4', pepper: PEPPER });
    const b = generateRuntimeApiKey({ siteIdShort: 'a1b2c3d4', pepper: PEPPER });
    expect(a.cleartext).not.toBe(b.cleartext);
    expect(a.hash).not.toBe(b.hash);
  });

  it('rejects a pepper shorter than 32 bytes', () => {
    expect(() =>
      generateRuntimeApiKey({ siteIdShort: 'a1b2c3d4', pepper: new Uint8Array(8) }),
    ).toThrow(/at least 32 bytes/);
  });

  it('rejects a malformed siteIdShort', () => {
    expect(() => generateRuntimeApiKey({ siteIdShort: 'a1b2', pepper: PEPPER })).toThrow(/8 hex/);
    expect(() => generateRuntimeApiKey({ siteIdShort: 'A1B2C3D4', pepper: PEPPER })).toThrow(/8 hex/);
    expect(() => generateRuntimeApiKey({ siteIdShort: 'g1b2c3d4', pepper: PEPPER })).toThrow(/8 hex/);
  });
});

describe('hashRuntimeApiKey()', () => {
  it('is deterministic', () => {
    const cleartext = 'gw_runtime_a1b2c3d4_xyz';
    expect(hashRuntimeApiKey(cleartext, PEPPER)).toBe(hashRuntimeApiKey(cleartext, PEPPER));
  });

  it('produces different hashes for different peppers', () => {
    const cleartext = 'gw_runtime_a1b2c3d4_xyz';
    const hashA = hashRuntimeApiKey(cleartext, PEPPER);
    const hashB = hashRuntimeApiKey(cleartext, randomBytes(32));
    expect(hashA).not.toBe(hashB);
  });

  it('rejects pepper < 32 bytes', () => {
    expect(() => hashRuntimeApiKey('x', new Uint8Array(16))).toThrow(/at least 32 bytes/);
  });
});

describe('compareKeyHashes()', () => {
  it('returns true for equal hashes', () => {
    const hash = hashRuntimeApiKey('test', PEPPER);
    expect(compareKeyHashes(hash, hash)).toBe(true);
  });

  it('returns false for unequal hashes of same length', () => {
    const a = hashRuntimeApiKey('a', PEPPER);
    const b = hashRuntimeApiKey('b', PEPPER);
    expect(compareKeyHashes(a, b)).toBe(false);
  });

  it('returns false for length mismatch', () => {
    expect(compareKeyHashes('abcd', 'abcdef')).toBe(false);
  });

  it('returns false for malformed hex (without throwing)', () => {
    expect(compareKeyHashes('zzzz', 'abcd')).toBe(false);
  });

  it('returns false when one input is empty', () => {
    expect(compareKeyHashes('', '')).toBe(false);
  });
});

describe('extractBearerKey()', () => {
  it('extracts the key from "Bearer <key>"', () => {
    expect(extractBearerKey('Bearer gw_runtime_a1b2c3d4_xyz')).toBe('gw_runtime_a1b2c3d4_xyz');
  });

  it('returns null for missing or malformed headers', () => {
    expect(extractBearerKey(undefined)).toBe(null);
    expect(extractBearerKey('')).toBe(null);
    expect(extractBearerKey('Basic abcd')).toBe(null);
    expect(extractBearerKey('Bearer')).toBe(null);
  });

  it('accepts keys containing base64url chars', () => {
    expect(extractBearerKey('Bearer gw_runtime_a1b2c3d4_xY-Z_123==')).toBe(
      'gw_runtime_a1b2c3d4_xY-Z_123==',
    );
  });

  it('rejects keys with whitespace or unsafe chars', () => {
    expect(extractBearerKey('Bearer key with space')).toBe(null);
  });
});

describe('siteIdShortFromKey()', () => {
  it('extracts the site-id-short from a well-formed key', () => {
    expect(siteIdShortFromKey('gw_runtime_a1b2c3d4_xyz')).toBe('a1b2c3d4');
  });

  it('returns null for malformed keys', () => {
    expect(siteIdShortFromKey('not-a-runtime-key')).toBe(null);
    expect(siteIdShortFromKey('gw_runtime__no-id')).toBe(null);
    expect(siteIdShortFromKey('gw_runtime_NOTHEX_xyz')).toBe(null);
  });
});
