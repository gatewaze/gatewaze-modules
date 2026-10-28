import { describe, expect, it } from 'vitest';
import { toPublicCalendarLocation } from '../public-location';

describe('toPublicCalendarLocation', () => {
  it('shapes a Luma-filled location', () => {
    expect(toPublicCalendarLocation({
      type: 'city',
      city: 'London',
      state: 'England',
      country: 'United Kingdom',
      country_code: 'GB',
      latitude: 51.507218,
      longitude: -0.127586,
      source: 'luma',
    })).toEqual({
      type: 'city',
      city: 'London',
      region: 'England',
      country: 'United Kingdom',
      country_code: 'GB',
      continent: null,
      latitude: 51.507218,
      longitude: -0.127586,
      source: 'luma',
    });
  });

  it('returns null for no location and for the form default {type: global}', () => {
    expect(toPublicCalendarLocation(null)).toBeNull();
    expect(toPublicCalendarLocation(undefined)).toBeNull();
    expect(toPublicCalendarLocation('London')).toBeNull();
    expect(toPublicCalendarLocation([])).toBeNull();
    expect(toPublicCalendarLocation({ type: 'global' })).toBeNull();
  });

  it('only copies known keys', () => {
    const out = toPublicCalendarLocation({ city: 'Austin', country_code: 'US', secret: 'x' });
    expect(out).not.toHaveProperty('secret');
    expect(Object.keys(out ?? {}).sort()).toEqual(
      ['city', 'continent', 'country', 'country_code', 'latitude', 'longitude', 'region', 'source', 'type'],
    );
  });

  it('treats a source-less location as manual and infers its type', () => {
    const out = toPublicCalendarLocation({ type: 'global', city: 'Berlin', country: 'Germany' });
    expect(out?.source).toBe('manual');
    expect(out?.type).toBe('city');
    expect(toPublicCalendarLocation({ country: 'Germany' })?.type).toBe('country');
  });

  it('drops a malformed country code and out-of-range or half coordinates', () => {
    const bad = toPublicCalendarLocation({ city: 'Paris', country_code: 'FRA', latitude: 120, longitude: 2.35 });
    expect(bad?.country_code).toBeNull();
    expect(bad?.latitude).toBeNull();
    expect(bad?.longitude).toBeNull();

    const half = toPublicCalendarLocation({ city: 'Paris', latitude: 48.85 });
    expect(half?.latitude).toBeNull();
    expect(half?.longitude).toBeNull();

    expect(toPublicCalendarLocation({ city: 'Paris', country_code: 'fr' })?.country_code).toBe('FR');
  });

  it('ignores an unknown source value', () => {
    expect(toPublicCalendarLocation({ city: 'Oslo', source: 'guess' })?.source).toBe('manual');
  });
});
