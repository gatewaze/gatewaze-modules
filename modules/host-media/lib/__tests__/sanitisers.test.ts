import { describe, it, expect } from 'vitest';
import { sanitisePostgrestSearch, pickFields, paramAsUuid, paramAsString } from '../sanitisers.js';

describe('sanitisePostgrestSearch', () => {
  it('strips PostgREST filter metacharacters', () => {
    expect(sanitisePostgrestSearch('foo,bar')).toBe('foobar');
    expect(sanitisePostgrestSearch('foo()')).toBe('foo');
    expect(sanitisePostgrestSearch('foo*bar')).toBe('foobar');
    expect(sanitisePostgrestSearch('foo\\bar')).toBe('foobar');
  });

  it('escapes ILIKE wildcards (% and _)', () => {
    expect(sanitisePostgrestSearch('100%')).toBe('100\\%');
    expect(sanitisePostgrestSearch('foo_bar')).toBe('foo\\_bar');
    expect(sanitisePostgrestSearch('a%b_c')).toBe('a\\%b\\_c');
  });

  it('handles mixed metachars + wildcards', () => {
    expect(sanitisePostgrestSearch('100,%foo()_*\\bar')).toBe('100\\%foo\\_bar');
  });

  it('caps length at 100', () => {
    const long = 'a'.repeat(150);
    expect(sanitisePostgrestSearch(long).length).toBe(100);
  });

  it('coerces non-strings safely', () => {
    expect(sanitisePostgrestSearch(null)).toBe('');
    expect(sanitisePostgrestSearch(undefined)).toBe('');
    expect(sanitisePostgrestSearch(42)).toBe('42');
  });
});

describe('pickFields', () => {
  const ALLOW = ['caption', 'alt_text', 'is_featured'] as const;

  it('keeps only allowlisted keys', () => {
    const out = pickFields({ caption: 'hi', host_id: 'evil', secret: 1 }, ALLOW);
    expect(out).toEqual({ caption: 'hi' });
  });

  it('drops everything when no allowlisted keys present', () => {
    expect(pickFields({ host_id: 'evil' }, ALLOW)).toEqual({});
  });

  it('returns {} for non-object body (defends against null/undefined)', () => {
    expect(pickFields(null, ALLOW)).toEqual({});
    expect(pickFields(undefined, ALLOW)).toEqual({});
    expect(pickFields('string', ALLOW)).toEqual({});
  });

  it('preserves allowed key even when value is null/false (intentional unset)', () => {
    expect(pickFields({ caption: null, is_featured: false }, ALLOW)).toEqual({
      caption: null,
      is_featured: false,
    });
  });
});

describe('paramAsUuid', () => {
  it('accepts valid UUIDs', () => {
    expect(paramAsUuid('7ffd554a-21d1-452d-a3ec-bcf952fb1652')).toBe('7ffd554a-21d1-452d-a3ec-bcf952fb1652');
  });
  it('rejects non-UUIDs', () => {
    expect(paramAsUuid('not-a-uuid')).toBeNull();
    expect(paramAsUuid('')).toBeNull();
    expect(paramAsUuid('7ffd554a')).toBeNull();
    expect(paramAsUuid(null)).toBeNull();
    expect(paramAsUuid(123)).toBeNull();
  });
});

describe('paramAsString', () => {
  it('accepts non-empty strings', () => {
    expect(paramAsString('site')).toBe('site');
  });
  it('rejects empty / non-strings', () => {
    expect(paramAsString('')).toBeNull();
    expect(paramAsString(null)).toBeNull();
    expect(paramAsString(undefined)).toBeNull();
  });
});

import { parseUuidList, validateMediaPatch } from '../sanitisers.js';

describe('parseUuidList', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  it('dedupes valid ids', () => {
    expect(parseUuidList([A, A.toUpperCase()])).toEqual([A]);
  });
  it('rejects empty, oversized, non-array and non-uuid input', () => {
    expect(parseUuidList([])).toBeNull();
    expect(parseUuidList('x')).toBeNull();
    expect(parseUuidList([A, 'nope'])).toBeNull();
    expect(parseUuidList([A, A], 1)).toBeNull();
  });
});

describe('validateMediaPatch', () => {
  it('accepts well-typed fields and truncates long text', () => {
    const r = validateMediaPatch({ caption: 'x'.repeat(3000), is_approved: true, access_level: 'public', sponsor_id: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value.caption as string).length).toBe(2000);
  });
  it('rejects wrong types and bad enums', () => {
    expect(validateMediaPatch({ is_featured: 'true' }).ok).toBe(false);
    expect(validateMediaPatch({ access_level: 'everyone' }).ok).toBe(false);
    expect(validateMediaPatch({ album_id: 'not-a-uuid' }).ok).toBe(false);
    expect(validateMediaPatch({ caption: 42 }).ok).toBe(false);
  });
});
