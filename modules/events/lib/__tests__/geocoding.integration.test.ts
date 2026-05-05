/**
 * Live integration tests for the geocoding helpers — hits real Nominatim
 * + OSRM. Disabled by default; opt in via:
 *
 *   GATEWAZE_RUN_INTEGRATION_TESTS=1 npx vitest run lib/__tests__/geocoding.integration.test.ts
 *
 * Why opt-in:
 *   - Exits CI / local dev runs by default (network, flakiness, OSM rate limits)
 *   - Gives operators a one-liner to verify their Nominatim/OSRM env vars
 *     before wiring distance calculations into a customer-visible flow
 *
 * Override the endpoints via the same env vars used at runtime so this
 * doubles as a smoke test for self-hosted instances:
 *   NOMINATIM_BASE_URL  default https://nominatim.openstreetmap.org
 *   OSRM_BASE_URL       default https://router.project-osrm.org
 *
 * The tests are tolerant of OSM data drift — assertions cover ranges
 * ("London is between 50 and 60 degrees north") rather than exact values.
 */

import { describe, expect, it } from 'vitest';
import { geocodePostcode, getDrivingRoute, haversineMeters } from '../geocoding.js';

const RUN_INTEGRATION = process.env['GATEWAZE_RUN_INTEGRATION_TESTS'] === '1';
const describeIf = RUN_INTEGRATION ? describe : describe.skip;
const NOMINATIM_BASE_URL = process.env['NOMINATIM_BASE_URL'];
const OSRM_BASE_URL = process.env['OSRM_BASE_URL'];

describeIf('geocoding integration (live network)', () => {
  it('geocodes a UK postcode within Greater London bounds', async () => {
    const result = await geocodePostcode('SW1A 1AA', {
      baseUrl: NOMINATIM_BASE_URL,
      countryCodes: ['GB'],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    // Buckingham Palace is ~51.501°N, -0.142°E
    expect(result.lat).toBeGreaterThan(51.4);
    expect(result.lat).toBeLessThan(51.6);
    expect(result.lng).toBeGreaterThan(-0.3);
    expect(result.lng).toBeLessThan(0.1);
  }, 15_000);

  it('geocodes a US ZIP within Manhattan bounds', async () => {
    const result = await geocodePostcode('10001', {
      baseUrl: NOMINATIM_BASE_URL,
      countryCodes: ['US'],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    // 10001 covers Chelsea / Penn Station — ~40.75°N, -74.0°W
    expect(result.lat).toBeGreaterThan(40.6);
    expect(result.lat).toBeLessThan(40.9);
    expect(result.lng).toBeGreaterThan(-74.1);
    expect(result.lng).toBeLessThan(-73.8);
  }, 15_000);

  it('returns null for a deliberately nonsense postcode', async () => {
    const result = await geocodePostcode('ZZZZ-NOPE-NOWHERE-9999', {
      baseUrl: NOMINATIM_BASE_URL,
    });
    expect(result).toBeNull();
  }, 15_000);

  it('fetches a sensible driving route between two known UK postcodes', async () => {
    // London Bridge ↔ Tower Bridge — both real, ~600 m apart, drive time
    // a few minutes through central London.
    const from = { lat: 51.5079, lng: -0.0877 };
    const to = { lat: 51.5055, lng: -0.0754 };
    const route = await getDrivingRoute(from, to, { baseUrl: OSRM_BASE_URL });
    expect(route).not.toBeNull();
    if (!route) return;
    // Bounds are wide on purpose — OSRM data + routing rules can shift these.
    // Distance: at least 400 m (the haversine baseline) and under 5 km.
    const baseline = haversineMeters(from, to);
    expect(route.distanceMeters).toBeGreaterThan(baseline);
    expect(route.distanceMeters).toBeLessThan(5_000);
    // Duration: at least 30 s, under 30 min.
    expect(route.durationSeconds).toBeGreaterThan(30);
    expect(route.durationSeconds).toBeLessThan(1_800);
  }, 30_000);

  it('returns null for an unrouteable pair (mid-Atlantic to mid-Pacific)', async () => {
    const route = await getDrivingRoute(
      { lat: 30.0, lng: -40.0 },
      { lat: 30.0, lng: -160.0 },
      { baseUrl: OSRM_BASE_URL },
    );
    // OSRM responds with code !== 'Ok' for unreachable pairs; the helper
    // surfaces null so callers fall back to haversine or omit the value.
    expect(route).toBeNull();
  }, 30_000);
});

describe('geocoding integration suite metadata', () => {
  it('reports whether integration tests ran (CI signal)', () => {
    if (!RUN_INTEGRATION) {
      // eslint-disable-next-line no-console
      console.log('[geocoding.integration] SKIPPED — set GATEWAZE_RUN_INTEGRATION_TESTS=1 to enable');
    }
    expect(true).toBe(true);
  });
});
