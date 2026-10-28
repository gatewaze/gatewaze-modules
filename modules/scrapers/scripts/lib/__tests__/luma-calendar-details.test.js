/**
 * Tests for the pure halves of luma-calendar-details: reading a Luma
 * calendar's place, and deciding whether a stored location still wants an
 * automatic value. The calendar shapes below are trimmed from the live
 * lu.ma/aaif-london and lu.ma/aaif-pittsburgh __NEXT_DATA__ (2026-10-28).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  lumaCalendarLocation,
  locationNeedsAutofill,
  populateLumaCalendarDetailsIfMissing,
} from '../luma-calendar-details.js';

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
    assert.equal(locationNeedsAutofill({ type: 'global', state: 'Bavaria' }), false);
    assert.equal(locationNeedsAutofill({ type: 'global', country_code: 'DE' }), false);
  });
});

// A supabase client that serves one calendars row and records RPC calls.
function fakeClient(row) {
  const rpcs = [];
  const builder = {
    select() { return builder; },
    eq() { return builder; },
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return {
    rpcs,
    from: () => builder,
    rpc: async (name, args) => { rpcs.push([name, args]); return { data: 1, error: null }; },
  };
}

describe('populateLumaCalendarDetailsIfMissing', () => {
  test('a calendar not on Luma gets the events fallback, without a page fetch', async () => {
    const row = { id: 'cal-not-luma', calendar_id: 'CAL-X', slug: 'x', cover_image_url: null, luma_calendar_id: null, location: null };
    const client = fakeClient(row);
    const out = await populateLumaCalendarDetailsIfMissing(client, row.id);
    assert.deepEqual(client.rpcs, [['calendars_autofill_location_from_events', { p_calendar_id: row.id }]]);
    assert.equal(out.location.source, 'events');
  });

  test('a second call for the same calendar inside six hours does nothing', async () => {
    const row = { id: 'cal-retry', calendar_id: 'CAL-Y', slug: 'y', cover_image_url: null, luma_calendar_id: null, location: null };
    const client = fakeClient(row);
    await populateLumaCalendarDetailsIfMissing(client, row.id);
    const again = await populateLumaCalendarDetailsIfMissing(client, row.id);
    assert.equal(again.reason, 'attempted-recently');
    assert.equal(client.rpcs.length, 1);
  });

  test('a calendar with a cover and a manual location is left alone', async () => {
    const row = { id: 'cal-done', calendar_id: 'CAL-Z', slug: 'z', cover_image_url: 'calendars/z.png', luma_calendar_id: 'cal-123', location: { type: 'city', city: 'Paris', source: 'manual' } };
    const client = fakeClient(row);
    const out = await populateLumaCalendarDetailsIfMissing(client, row.id);
    assert.equal(out.reason, 'nothing-missing');
    assert.equal(client.rpcs.length, 0);
  });
});
