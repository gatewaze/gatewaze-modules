import { describe, it, expect } from 'vitest';
import {
  pct, heatColor, maxOf, bestLocalHour, hourLabel, resolveOptionLabel, buildRegionSplits,
} from '../geo-format.js';
import { project, countryName, centroid } from '../world-geo.js';
import { schemaMatches, isEmpty } from '../geo-types.js';
import type { LocalTimeRow, OptionGeoRow } from '../geo-types.js';

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

describe('resolveOptionLabel', () => {
  it('keeps a real label', () => {
    expect(resolveOptionLabel('Agree', 0)).toBe('Agree');
  });
  it('replaces a generic "Option N" with block-supplied label', () => {
    expect(resolveOptionLabel('Option 1', 0, { 0: 'Agree', 1: 'Disagree' })).toBe('Agree');
  });
  it('falls back to Option N when nothing better', () => {
    expect(resolveOptionLabel('', 1)).toBe('Option 2');
    expect(resolveOptionLabel(null, 0)).toBe('Option 1');
  });
});

describe('buildRegionSplits', () => {
  // Unequal totals (US 200, DE 100) so the global split (Agree 125/300 ≈ 0.417)
  // is not the midpoint — DE (Agree 0.05) is clearly farther from it than US
  // (Agree 0.60). With 2 options, divergence = 2·|share − globalShare|.
  const rows: OptionGeoRow[] = [
    { edition_link_id: 'l1', option_label: 'Agree', region_code: 'US', region_name: 'US', clicks: 120, share: 0.6 },
    { edition_link_id: 'l2', option_label: 'Disagree', region_code: 'US', region_name: 'US', clicks: 80, share: 0.4 },
    { edition_link_id: 'l1', option_label: 'Agree', region_code: 'DE', region_name: 'DE', clicks: 5, share: 0.05 },
    { edition_link_id: 'l2', option_label: 'Disagree', region_code: 'DE', region_name: 'DE', clicks: 95, share: 0.95 },
  ];
  it('computes per-region shares summing to 1', () => {
    const splits = buildRegionSplits(rows);
    const us = splits.find((s) => s.region_code === 'US')!;
    expect(us.total).toBe(200);
    expect(us.options.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 5);
    expect(us.options[0].label).toBe('Agree'); // sorted by clicks desc
  });
  it('ranks most-divergent region first', () => {
    const splits = buildRegionSplits(rows);
    expect(splits[0].region_code).toBe('DE'); // DE diverges more from global than US
    expect(splits[0].divergence).toBeGreaterThan(splits[1].divergence);
  });
  it('handles empty', () => expect(buildRegionSplits([])).toEqual([]));
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
