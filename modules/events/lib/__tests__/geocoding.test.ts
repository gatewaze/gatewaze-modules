import { describe, expect, it, vi } from 'vitest';
import {
  geocodePostcode,
  haversineMeters,
  formatDistance,
  getDrivingRoute,
  formatDuration,
} from '../geocoding.js';

function makeFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const r = responses[i++];
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
    } as unknown as Response;
  });
}

describe('geocodePostcode', () => {
  it('returns lat/lng for a UK postcode hit on the postalcode endpoint', async () => {
    const fetchFn = makeFetch([
      {
        ok: true,
        body: [
          { lat: '54.7766', lon: '-1.5742', display_name: 'Durham, DH1 4DJ, UK' },
        ],
      },
    ]);
    const result = await geocodePostcode('DH1 4DJ', { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(result).toEqual({
      lat: 54.7766,
      lng: -1.5742,
      displayName: 'Durham, DH1 4DJ, UK',
    });
    // Only one call needed (postalcode endpoint hit)
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url).toContain('postalcode=DH1+4DJ');
  });

  it('falls back to free-text search when postalcode endpoint returns empty', async () => {
    const fetchFn = makeFetch([
      { ok: true, body: [] }, // postalcode endpoint: no result
      {
        ok: true,
        body: [
          { lat: '40.7128', lon: '-74.006', display_name: 'New York, NY, USA' },
        ],
      },
    ]);
    const result = await geocodePostcode('NYC', { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(result).toEqual({
      lat: 40.7128,
      lng: -74.006,
      displayName: 'New York, NY, USA',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const fallbackUrl = String(fetchFn.mock.calls[1]?.[0]);
    expect(fallbackUrl).toContain('q=NYC');
  });

  it('returns null for empty input without calling fetch', async () => {
    const fetchFn = vi.fn();
    const result = await geocodePostcode('   ', { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns null when both postalcode + free-text return empty', async () => {
    const fetchFn = makeFetch([
      { ok: true, body: [] },
      { ok: true, body: [] },
    ]);
    const result = await geocodePostcode('zxqv', { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(result).toBeNull();
  });

  it('returns null when both endpoints return non-ok', async () => {
    const fetchFn = makeFetch([
      { ok: false, status: 503, body: null },
      { ok: false, status: 503, body: null },
    ]);
    const result = await geocodePostcode('DH1', { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('passes country biasing correctly', async () => {
    const fetchFn = makeFetch([
      { ok: true, body: [{ lat: '51.5', lon: '-0.1', display_name: 'London' }] },
    ]);
    await geocodePostcode('SW1A 1AA', {
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      countryCodes: ['GB', 'IE'],
    });
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url).toContain('countrycodes=gb%2Cie');
  });

  it('discards results with non-numeric lat/lng', async () => {
    const fetchFn = makeFetch([
      { ok: true, body: [{ lat: 'banana', lon: '-0.1', display_name: 'X' }] },
      { ok: true, body: [] }, // free-text fallback also empty
    ]);
    const result = await geocodePostcode('DH1', { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(result).toBeNull();
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchFn = makeFetch([
      { ok: true, body: [{ lat: '1', lon: '2', display_name: 'x' }] },
    ]);
    await geocodePostcode('test', {
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      baseUrl: 'https://nominatim.example.com/',
    });
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url.startsWith('https://nominatim.example.com/search?')).toBe(true);
  });
});

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    const p = { lat: 51.5, lng: -0.1 };
    expect(haversineMeters(p, p)).toBe(0);
  });

  it('approximates known distance: London → Paris ≈ 344 km', () => {
    const london = { lat: 51.5074, lng: -0.1278 };
    const paris = { lat: 48.8566, lng: 2.3522 };
    const d = haversineMeters(london, paris);
    // True great-circle is ~343.5 km — accept ±2 km tolerance
    expect(d).toBeGreaterThan(341_000);
    expect(d).toBeLessThan(346_000);
  });

  it('is symmetric', () => {
    const a = { lat: 40, lng: -74 };
    const b = { lat: 34, lng: -118 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 5);
  });

  it('handles antipodal points without NaN (clamped sqrt)', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    // Earth half-circumference ≈ 20,015 km
    expect(d).toBeGreaterThan(20_000_000);
    expect(d).toBeLessThan(20_100_000);
    expect(Number.isFinite(d)).toBe(true);
  });
});

describe('formatDistance', () => {
  it('formats < 0.1 mi as yards', () => {
    expect(formatDistance(50)).toMatch(/yd$/);
  });

  it('formats short miles with one decimal', () => {
    expect(formatDistance(1609)).toBe('1.0 mi');
    expect(formatDistance(8047)).toBe('5.0 mi');
  });

  it('formats >10 mi as integer', () => {
    expect(formatDistance(32_180)).toBe('20 mi');
  });

  it('km mode uses metres for short distances', () => {
    expect(formatDistance(450, { unit: 'km' })).toBe('450 m');
  });

  it('km mode uses 1-decimal km for medium', () => {
    expect(formatDistance(2_500, { unit: 'km' })).toBe('2.5 km');
  });

  it('km mode integer km for long distances', () => {
    expect(formatDistance(125_000, { unit: 'km' })).toBe('125 km');
  });
});

describe('getDrivingRoute', () => {
  it('returns parsed distance + duration on Ok response', async () => {
    const fetchFn = makeFetch([
      {
        ok: true,
        body: { code: 'Ok', routes: [{ distance: 12_345, duration: 720 }] },
      },
    ]);
    const route = await getDrivingRoute(
      { lat: 51.5, lng: -0.1 },
      { lat: 51.6, lng: -0.05 },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    );
    expect(route).toEqual({ distanceMeters: 12_345, durationSeconds: 720 });
  });

  it('uses lon,lat order in the URL (OSRM gotcha)', async () => {
    const fetchFn = makeFetch([
      { ok: true, body: { code: 'Ok', routes: [{ distance: 1, duration: 1 }] } },
    ]);
    await getDrivingRoute(
      { lat: 1.5, lng: 2.5 },
      { lat: 3.5, lng: 4.5 },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    );
    const url = String(fetchFn.mock.calls[0]?.[0]);
    // expected: 2.5,1.5;4.5,3.5 (lng,lat;lng,lat)
    expect(url).toContain('/2.5,1.5;4.5,3.5');
  });

  it('returns null on non-Ok OSRM code', async () => {
    const fetchFn = makeFetch([
      { ok: true, body: { code: 'NoRoute', routes: [] } },
    ]);
    const route = await getDrivingRoute(
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0 },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    );
    expect(route).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network down'); });
    const route = await getDrivingRoute(
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    );
    expect(route).toBeNull();
  });

  it('honours custom profile (cycling)', async () => {
    const fetchFn = makeFetch([
      { ok: true, body: { code: 'Ok', routes: [{ distance: 5, duration: 5 }] } },
    ]);
    await getDrivingRoute(
      { lat: 0, lng: 0 },
      { lat: 1, lng: 1 },
      { fetch: fetchFn as unknown as typeof globalThis.fetch, profile: 'cycling' },
    );
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url).toContain('/route/v1/cycling/');
  });
});

describe('formatDuration', () => {
  it('formats sub-minute as "< 1 min"', () => {
    expect(formatDuration(20)).toBe('< 1 min');
  });

  it('formats minutes', () => {
    expect(formatDuration(720)).toBe('12 min');
    expect(formatDuration(3540)).toBe('59 min');
  });

  it('formats whole hours without minutes part', () => {
    expect(formatDuration(3600)).toBe('1 hr');
    expect(formatDuration(7200)).toBe('2 hr');
  });

  it('formats hours + minutes', () => {
    expect(formatDuration(5040)).toBe('1 hr 24 min');
    expect(formatDuration(9_000)).toBe('2 hr 30 min');
  });
});
