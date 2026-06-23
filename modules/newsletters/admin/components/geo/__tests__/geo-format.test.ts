import { describe, it, expect } from 'vitest';
import {
  pct, heatColor, maxOf, bestLocalHour, hourLabel,
} from '../geo-format.js';
import { project, countryName, centroid } from '../world-geo.js';
import { schemaMatches, isEmpty } from '../geo-types.js';
import type { LocalTimeRow } from '../geo-types.js';

describe('pct', () => {
  it('formats a 0..1 rate, handles null', () => {
    expect(pct(0.1234)).toBe('12.3%');
    expect(pct(null)).toBe('—');
    expect(pct(undefined)).toBe('—');
    expect(pct(0.5, 0)).toBe('50%');
  });
});

describe('heatColor', () => {
  it('returns rgb strings and clamps out-of-range', () => {
    expect(heatColor(0)).toMatch(/^rgb\(/);
    expect(heatColor(1)).toMatch(/^rgb\(/);
    expect(heatColor(-5)).toBe(heatColor(0));
    expect(heatColor(5)).toBe(heatColor(1));
  });
});

describe('maxOf', () => {
  it('finds max, treats null/undefined as 0', () => {
    expect(maxOf([{ v: 3 }, { v: 7 }, { v: 2 }], (r) => r.v)).toBe(7);
    expect(maxOf([{ v: null }, { v: 4 }], (r) => r.v)).toBe(4);
    expect(maxOf([], () => 1)).toBe(0);
  });
});

describe('bestLocalHour', () => {
  it('uses normalised rate (unbiased by region size), not raw counts', () => {
    // Hour 9 has a huge raw count but tiny rate; hour 7 has the best rate.
    const rows: LocalTimeRow[] = [
      { dow: 1, hour: 9, event_count: 1000, recipients_in_tz: 100000, rate: 0.01 },
      { dow: 1, hour: 7, event_count: 50, recipients_in_tz: 100, rate: 0.5 },
    ];
    expect(bestLocalHour(rows)?.hour).toBe(7);
  });
  it('falls back to event_count when rate absent', () => {
    const rows: LocalTimeRow[] = [
      { dow: 1, hour: 3, event_count: 5, recipients_in_tz: 10, rate: null },
      { dow: 1, hour: 8, event_count: 9, recipients_in_tz: 10, rate: null },
    ];
    expect(bestLocalHour(rows)?.hour).toBe(8);
  });
  it('returns null on empty', () => expect(bestLocalHour([])).toBeNull());
});

describe('hourLabel', () => {
  it('renders 12h labels', () => {
    expect(hourLabel(0)).toBe('12am');
    expect(hourLabel(9)).toBe('9am');
    expect(hourLabel(12)).toBe('12pm');
    expect(hourLabel(18)).toBe('6pm');
  });
});

describe('world-geo', () => {
  it('projects lng/lat into the viewport with origin top-left', () => {
    const w = 360, h = 180;
    expect(project(-180, 90, w, h)).toEqual({ x: 0, y: 0 });
    expect(project(180, -90, w, h)).toEqual({ x: 360, y: 180 });
    expect(project(0, 0, w, h)).toEqual({ x: 180, y: 90 });
  });
  it('maps codes to names, with Other + unknown handling', () => {
    expect(countryName('US')).toBe('United States');
    expect(countryName('__other__')).toBe('Other');
    expect(countryName('XX')).toBe('XX');
    expect(countryName(null)).toBe('Unknown');
  });
  it('returns centroids for known codes, null otherwise', () => {
    expect(centroid('US')).not.toBeNull();
    expect(centroid('XX')).toBeNull();
  });
});

describe('geo-types guards', () => {
  it('schemaMatches checks version', () => {
    expect(schemaMatches({ schema_version: 1, total_events: 1, coverage_pct: 1, suppressed_buckets: 0, tz_fallback: 0 })).toBe(true);
    expect(schemaMatches({ schema_version: 2, total_events: 1, coverage_pct: 1, suppressed_buckets: 0, tz_fallback: 0 })).toBe(false);
    expect(schemaMatches(undefined)).toBe(false);
  });
  it('isEmpty detects no-data envelopes', () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty({ data: [], meta: { schema_version: 1, total_events: 0, coverage_pct: 0, suppressed_buckets: 0, tz_fallback: 0 } })).toBe(true);
    expect(isEmpty({ data: [{}], meta: { schema_version: 1, total_events: 5, coverage_pct: 1, suppressed_buckets: 0, tz_fallback: 0 } })).toBe(false);
  });
});
