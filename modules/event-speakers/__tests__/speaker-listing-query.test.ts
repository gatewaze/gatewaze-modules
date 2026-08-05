import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPEAKER_PAGE_SIZE,
  DEFAULT_SPEAKER_SORT,
  MAX_SPEAKER_PAGE_SIZE,
  MAX_SPEAKER_SEARCH_LENGTH,
  buildSpeakerListingQuery,
  defaultDirectionFor,
  isEventUuid,
  normalizeSpeakerDirection,
  normalizeSpeakerSort,
  sanitizeSpeakerSearch,
  speakerPageCount,
} from '../admin/services/speakerListingQuery';

const EVENT_UUID = '3f6c1b2a-9d4e-4c1a-8b7f-0a1b2c3d4e5f';

describe('sanitizeSpeakerSearch', () => {
  it('returns empty string for null / undefined', () => {
    expect(sanitizeSpeakerSearch(null)).toBe('');
    expect(sanitizeSpeakerSearch(undefined)).toBe('');
  });

  it('strips the PostgREST filter-grammar metacharacters', () => {
    // `,` ends a filter, `(` `)` group, `*` is the wildcard, `\` escapes.
    expect(sanitizeSpeakerSearch('jane,id.gt.0')).toBe('janeid.gt.0');
    expect(sanitizeSpeakerSearch('a(b)c')).toBe('abc');
    expect(sanitizeSpeakerSearch('a*b')).toBe('ab');
    expect(sanitizeSpeakerSearch('a\\b')).toBe('ab');
  });

  it('caps the term length', () => {
    const long = 'x'.repeat(MAX_SPEAKER_SEARCH_LENGTH + 50);
    expect(sanitizeSpeakerSearch(long)).toHaveLength(MAX_SPEAKER_SEARCH_LENGTH);
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeSpeakerSearch('  jane  ')).toBe('jane');
    expect(sanitizeSpeakerSearch('   ')).toBe('');
  });

  it('leaves an ordinary term untouched', () => {
    expect(sanitizeSpeakerSearch("Jane O'Neill")).toBe("Jane O'Neill");
  });
});

describe('normalizeSpeakerSort', () => {
  it('accepts every allowlisted column', () => {
    for (const column of ['name', 'company', 'email', 'event_count']) {
      expect(normalizeSpeakerSort(column)).toBe(column);
    }
  });

  it('falls back to the default for anything else', () => {
    // An unvalidated sort param would otherwise reach PostgREST's `order=`.
    expect(normalizeSpeakerSort('id')).toBe(DEFAULT_SPEAKER_SORT);
    expect(normalizeSpeakerSort('name.desc,email')).toBe(DEFAULT_SPEAKER_SORT);
    expect(normalizeSpeakerSort(undefined)).toBe(DEFAULT_SPEAKER_SORT);
    expect(normalizeSpeakerSort(42)).toBe(DEFAULT_SPEAKER_SORT);
  });
});

describe('normalizeSpeakerDirection', () => {
  it('accepts asc and desc, case-insensitively', () => {
    expect(normalizeSpeakerDirection('asc', 'name')).toBe('asc');
    expect(normalizeSpeakerDirection('DESC', 'name')).toBe('desc');
  });

  it('falls back to the column default for anything else', () => {
    expect(normalizeSpeakerDirection('sideways', 'name')).toBe('asc');
    expect(normalizeSpeakerDirection(null, 'event_count')).toBe('desc');
  });
});

describe('defaultDirectionFor', () => {
  it('sorts the event count most-first and text columns A-Z', () => {
    expect(defaultDirectionFor('event_count')).toBe('desc');
    expect(defaultDirectionFor('name')).toBe('asc');
    expect(defaultDirectionFor('company')).toBe('asc');
    expect(defaultDirectionFor('email')).toBe('asc');
  });
});

describe('isEventUuid', () => {
  it('accepts a well-formed uuid in either case', () => {
    expect(isEventUuid(EVENT_UUID)).toBe(true);
    expect(isEventUuid(EVENT_UUID.toUpperCase())).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isEventUuid('')).toBe(false);
    expect(isEventUuid('not-a-uuid')).toBe(false);
    expect(isEventUuid(`${EVENT_UUID},id.gt.0`)).toBe(false);
    expect(isEventUuid(null)).toBe(false);
    expect(isEventUuid(123)).toBe(false);
  });
});

describe('speakerPageCount', () => {
  it('rounds up partial pages', () => {
    expect(speakerPageCount(51, 25)).toBe(3);
    expect(speakerPageCount(50, 25)).toBe(2);
  });

  it('never drops below one page', () => {
    expect(speakerPageCount(0, 25)).toBe(1);
    expect(speakerPageCount(-1, 25)).toBe(1);
    expect(speakerPageCount(10, 0)).toBe(1);
  });
});

describe('buildSpeakerListingQuery', () => {
  it('defaults to name ascending, page 1', () => {
    const q = buildSpeakerListingQuery();
    expect(q.sort).toBe('name');
    expect(q.direction).toBe('asc');
    expect(q.ascending).toBe(true);
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(DEFAULT_SPEAKER_PAGE_SIZE);
    expect(q.from).toBe(0);
    expect(q.to).toBe(DEFAULT_SPEAKER_PAGE_SIZE - 1);
    expect(q.orFilter).toBeNull();
    expect(q.eventId).toBeNull();
  });

  it('defaults event_count to descending without an explicit dir', () => {
    const q = buildSpeakerListingQuery({ sort: 'event_count' });
    expect(q.direction).toBe('desc');
    expect(q.ascending).toBe(false);
  });

  it('honours an explicit ascending event_count', () => {
    const q = buildSpeakerListingQuery({ sort: 'event_count', dir: 'asc' });
    expect(q.ascending).toBe(true);
  });

  it('computes inclusive range bounds from page and pageSize', () => {
    const q = buildSpeakerListingQuery({ page: 3, pageSize: 10 });
    expect(q.from).toBe(20);
    expect(q.to).toBe(29);
  });

  it('clamps pageSize to the maximum', () => {
    expect(buildSpeakerListingQuery({ pageSize: 5000 }).pageSize).toBe(MAX_SPEAKER_PAGE_SIZE);
  });

  it('rejects non-positive or unparseable paging inputs', () => {
    expect(buildSpeakerListingQuery({ page: 0 }).page).toBe(1);
    expect(buildSpeakerListingQuery({ page: -4 }).page).toBe(1);
    expect(buildSpeakerListingQuery({ page: 'abc' }).page).toBe(1);
    expect(buildSpeakerListingQuery({ pageSize: 0 }).pageSize).toBe(DEFAULT_SPEAKER_PAGE_SIZE);
    expect(buildSpeakerListingQuery({ pageSize: 'lots' }).pageSize).toBe(DEFAULT_SPEAKER_PAGE_SIZE);
  });

  it('accepts numeric strings from the URL', () => {
    const q = buildSpeakerListingQuery({ page: '2', pageSize: '10' });
    expect(q.page).toBe(2);
    expect(q.pageSize).toBe(10);
    expect(q.from).toBe(10);
  });

  it('builds an or-filter across name, email and company', () => {
    const q = buildSpeakerListingQuery({ search: 'jane' });
    expect(q.orFilter).toBe('name.ilike.%jane%,email.ilike.%jane%,company.ilike.%jane%');
  });

  it('never lets an injection payload into the or-filter value', () => {
    const q = buildSpeakerListingQuery({ search: 'jane,id.gt.0(*\\)' });
    const orFilter = q.orFilter as string;
    // The sanitised term is what got interpolated…
    expect(orFilter).toContain('%janeid.gt.0%');
    // …and the injection signature is gone. (Don't assert the whole string is
    // free of commas — the or() scaffolding legitimately uses them.)
    expect(orFilter).not.toContain('%jane,');
    expect(orFilter).not.toContain('(*');
    expect(orFilter).not.toContain('\\)');
    // Still exactly three disjuncts.
    expect(orFilter.split(',')).toHaveLength(3);
  });

  it('produces no or-filter when the search sanitises away to nothing', () => {
    expect(buildSpeakerListingQuery({ search: '(*)' }).orFilter).toBeNull();
    expect(buildSpeakerListingQuery({ search: '   ' }).orFilter).toBeNull();
  });

  it('passes through a valid eventId and drops an invalid one', () => {
    expect(buildSpeakerListingQuery({ eventId: EVENT_UUID }).eventId).toBe(EVENT_UUID);
    expect(buildSpeakerListingQuery({ eventId: 'all' }).eventId).toBeNull();
    expect(buildSpeakerListingQuery({ eventId: '' }).eventId).toBeNull();
    expect(buildSpeakerListingQuery({ eventId: `${EVENT_UUID}}` }).eventId).toBeNull();
  });
});
