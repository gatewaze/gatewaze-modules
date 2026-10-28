/**
 * Tests for the pure halves of luma-calendar-details: reading a Luma
 * calendar's place, and deciding whether a stored location still wants an
 * automatic value. The calendar shapes below are trimmed from the live
 * lu.ma/aaif-london and lu.ma/aaif-pittsburgh __NEXT_DATA__ (2026-10-28).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lumaCalendarLocation, locationNeedsAutofill } from '../luma-calendar-details.js';

const london = {
  coordinate: { longitude: -0.127586, latitude: 51.507218 },
  location: {
    city: 'London',
    region: 'England',
    country: 'United Kingdom',
    place_id: 'ChIJdd4hrwug2EcRmSrV3Vo6llI',
    timezone: 'Europe/London',
    country_code: 'GB',
  },
  cover_image_url: 'https://images.lumacdn.com/calendar-cover-images/x.png',
};

describe('lumaCalendarLocation', () => {
  test('maps Luma location and coordinate to CalendarLocation fields', () => {
    assert.deepEqual(lumaCalendarLocation(london), {
      city: 'London',
      state: 'England',
      country: 'United Kingdom',
      country_code: 'GB',
      latitude: 51.507218,
      longitude: -0.127586,
    });
  });

  test('drops coordinates unless both are finite numbers', () => {
    const loc = lumaCalendarLocation({ ...london, coordinate: { latitude: 51.5, longitude: null } });
    assert.equal(loc.latitude, undefined);
    assert.equal(loc.longitude, undefined);
    assert.equal(loc.city, 'London');
  });

  test('upper-cases the country code and trims strings', () => {
    const loc = lumaCalendarLocation({ location: { city: ' Pittsburgh ', country_code: 'us' } });
    assert.deepEqual(loc, { city: 'Pittsburgh', country_code: 'US' });
  });

  test('returns null when Luma has no place for the calendar', () => {
    assert.equal(lumaCalendarLocation({}), null);
    assert.equal(lumaCalendarLocation(null), null);
    assert.equal(lumaCalendarLocation({ location: null }), null);
    assert.equal(lumaCalendarLocation({ location: { timezone: 'UTC', region: 'Somewhere' } }), null);
  });
});

describe('locationNeedsAutofill', () => {
  test('fills an absent location', () => {
    assert.equal(locationNeedsAutofill(null), true);
    assert.equal(locationNeedsAutofill(undefined), true);
  });

  test('fills the Settings form default {type: global}', () => {
    assert.equal(locationNeedsAutofill({ type: 'global' }), true);
    assert.equal(locationNeedsAutofill({}), true);
  });

  test('upgrades an events-derived location', () => {
    assert.equal(locationNeedsAutofill({ type: 'city', city: 'Austin', source: 'events' }), true);
  });

  test('leaves Luma-derived and manual locations alone', () => {
    assert.equal(locationNeedsAutofill({ type: 'city', city: 'London', source: 'luma' }), false);
    assert.equal(locationNeedsAutofill({ type: 'global', source: 'manual' }), false);
  });

  test('treats a legacy location an admin typed in as manual', () => {
    assert.equal(locationNeedsAutofill({ type: 'city', city: 'Berlin' }), false);
    assert.equal(locationNeedsAutofill({ type: 'global', country: 'Germany' }), false);
  });
});
