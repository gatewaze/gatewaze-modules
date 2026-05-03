import { describe, expect, it } from 'vitest';
import { semverGte, semverLt } from '../internal-git-server-impl.js';

describe('semverGte', () => {
  it('returns true for equal versions', () => {
    expect(semverGte('1.0.0', '1.0.0')).toBe(true);
    expect(semverGte('2.5.3', '2.5.3')).toBe(true);
  });

  it('compares major version', () => {
    expect(semverGte('2.0.0', '1.9.9')).toBe(true);
    expect(semverGte('1.9.9', '2.0.0')).toBe(false);
  });

  it('compares minor version when major equal', () => {
    expect(semverGte('1.5.0', '1.4.999')).toBe(true);
    expect(semverGte('1.4.999', '1.5.0')).toBe(false);
  });

  it('compares patch version when major + minor equal', () => {
    expect(semverGte('1.5.10', '1.5.5')).toBe(true);
    expect(semverGte('1.5.5', '1.5.10')).toBe(false);
  });

  it('throws on malformed input', () => {
    expect(() => semverGte('not.a.version', '1.0.0')).toThrow(/invalid semver/);
    expect(() => semverGte('1.0', '1.0.0')).toThrow(/invalid semver/);
    expect(() => semverGte('1', '1.0.0')).toThrow(/invalid semver/);
  });

  it('handles pre-release suffixes (treated as base version)', () => {
    expect(semverGte('1.5.0-rc.1', '1.5.0')).toBe(true);
  });
});

describe('semverLt', () => {
  it('is the inverse of semverGte', () => {
    expect(semverLt('1.0.0', '2.0.0')).toBe(true);
    expect(semverLt('2.0.0', '1.0.0')).toBe(false);
    expect(semverLt('1.5.5', '1.5.5')).toBe(false);
  });
});
