import { describe, it, expect } from 'vitest';
import { isPlausibleEmail, normaliseEmail } from '../email';

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const e of ['seed1@example.com', 'a.b+tag@sub.example.co.uk', 'x@y.zz']) {
      expect(isPlausibleEmail(e)).toBe(true);
    }
  });

  it('rejects malformed shapes', () => {
    for (const e of ['', 'nope', '@example.com', 'a@', 'a@b', 'a b@example.com',
                     'a@@example.com', 'a@.com', 'a@example.', 'a@ex..com']) {
      expect(isPlausibleEmail(e)).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 42, {}, []]) {
      expect(isPlausibleEmail(v)).toBe(false);
    }
  });

  it('enforces a length cap', () => {
    expect(isPlausibleEmail('a'.repeat(250) + '@e.com')).toBe(false);
  });

  it('stays linear on the pathological input that made the old regex quadratic', () => {
    // The previous /^[^@\s]+@[^@\s]+\.[^@\s]+$/ backtracked badly on this shape.
    // Guard the fix with a wall-clock bound rather than trusting inspection.
    const evil = 'a@' + '!.'.repeat(60) + '!';
    const started = Date.now();
    for (let i = 0; i < 2000; i++) isPlausibleEmail(evil);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('normaliseEmail', () => {
  it('trims and lowercases valid input', () => {
    expect(normaliseEmail('  Seed@Example.COM ')).toBe('seed@example.com');
  });

  it('returns null for anything invalid', () => {
    expect(normaliseEmail('not-an-email')).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });
});
