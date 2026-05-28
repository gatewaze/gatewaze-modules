/**
 * Tests for normalizeServiceResponse — the pure helper that translates
 * scrapling-fetcher responses into the shape downstream code (the slow
 * scrapers' fetchEventPageData callers) expects.
 *
 * The contract these tests defend: downstream code must NOT be able to
 * tell whether the data came through the fast (HTTP) or slow (browser)
 * path. If a field downstream depends on changes shape, this test
 * should be updated alongside.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServiceResponse } from '../luma-fast-normalize.js';


function sampleEventData(overrides = {}) {
  return {
    api_id: 'evt-abc123',
    name: 'Test event',
    start_at: '2026-06-01T18:00:00Z',
    end_at: '2026-06-01T20:00:00Z',
    timezone: 'America/Los_Angeles',
    cover_url: 'https://images.lumacdn.com/event-covers/abc.jpg',
    location_type: 'in-person',
    description_mirror: '<p>hi</p>',
    coordinate: { latitude: 37.78, longitude: -122.41 },
    geo_address_info: {
      city: 'San Francisco',
      country: 'United States',
      country_code: 'US',
      region: 'California',
      address: '123 Market St',
      full_address: '123 Market St, San Francisco, CA',
    },
    ...overrides,
  };
}

function wrap(eventData, calendarData = null) {
  return {
    nextData: {
      props: {
        pageProps: {
          initialData: {
            data: {
              event: eventData,
              ...(calendarData ? { calendar: calendarData } : {}),
            },
          },
        },
      },
    },
  };
}


describe('normalizeServiceResponse — happy path', () => {
  test('produces the contract shape', () => {
    const out = normalizeServiceResponse(wrap(sampleEventData()));
    assert.deepEqual(Object.keys(out).sort(), [
      'coverImageUrl', 'isVirtual', 'lumaData', 'lumaPageData', 'pageContent',
    ]);
  });

  test('maps every field downstream relies on', () => {
    const out = normalizeServiceResponse(wrap(sampleEventData()));
    assert.equal(out.coverImageUrl, 'https://images.lumacdn.com/event-covers/abc.jpg');
    assert.equal(out.pageContent, '');
    assert.equal(out.isVirtual, false);
    assert.equal(out.lumaData.lumaEventId, 'evt-abc123');
    assert.equal(out.lumaData.name, 'Test event');
    assert.equal(out.lumaData.startAt, '2026-06-01T18:00:00Z');
    assert.equal(out.lumaData.endAt, '2026-06-01T20:00:00Z');
    assert.equal(out.lumaData.timezone, 'America/Los_Angeles');
    assert.equal(out.lumaData.coverUrl, 'https://images.lumacdn.com/event-covers/abc.jpg');
    assert.equal(out.lumaData.latitude, 37.78);
    assert.equal(out.lumaData.longitude, -122.41);
    assert.equal(out.lumaData.city, 'San Francisco');
    assert.equal(out.lumaData.country, 'United States');
    assert.equal(out.lumaData.countryCode, 'US');
    assert.equal(out.lumaData.region, 'California');
    assert.equal(out.lumaData.venueAddress, '123 Market St');
    assert.equal(out.lumaData.fullAddress, '123 Market St, San Francisco, CA');
    assert.equal(out.lumaData.locationType, 'in-person');
    assert.equal(out.lumaData.description, '<p>hi</p>');
  });

  test('isVirtual=true when location_type is "online"', () => {
    const out = normalizeServiceResponse(wrap(sampleEventData({ location_type: 'online' })));
    assert.equal(out.isVirtual, true);
  });

  test('falls back to description when description_mirror missing', () => {
    const out = normalizeServiceResponse(wrap(sampleEventData({
      description_mirror: undefined,
      description: 'plain description text',
    })));
    assert.equal(out.lumaData.description, 'plain description text');
  });

  test('falls back to geo_latitude/geo_longitude when coordinate absent', () => {
    const out = normalizeServiceResponse(wrap(sampleEventData({
      coordinate: undefined,
      geo_latitude: 51.5,
      geo_longitude: -0.12,
    })));
    assert.equal(out.lumaData.latitude, 51.5);
    assert.equal(out.lumaData.longitude, -0.12);
  });
});


describe('normalizeServiceResponse — privacy stripping', () => {
  test('strips guests and user from persisted lumaPageData', () => {
    const next = wrap(sampleEventData());
    next.nextData.props.pageProps.initialData.data.guests = [{ name: 'Alice', email: 'a@x' }];
    next.nextData.props.pageProps.initialData.data.user = { id: 'u', email: 'me@x' };
    const out = normalizeServiceResponse(next);
    const persistedData = out.lumaPageData.props.pageProps.initialData.data;
    assert.equal(persistedData.guests, undefined);
    assert.equal(persistedData.user, undefined);
    assert.ok(persistedData.event);
  });

  test('does not mutate the input nextData', () => {
    const next = wrap(sampleEventData());
    next.nextData.props.pageProps.initialData.data.guests = [{ name: 'Alice' }];
    normalizeServiceResponse(next);
    assert.deepEqual(
      next.nextData.props.pageProps.initialData.data.guests,
      [{ name: 'Alice' }],
      'input must be untouched',
    );
  });
});


describe('normalizeServiceResponse — degraded inputs', () => {
  test('null serviceResult', () => {
    const out = normalizeServiceResponse(null);
    assert.equal(out.coverImageUrl, null);
    assert.equal(out.lumaData, null);
    assert.equal(out.lumaPageData, null);
    assert.equal(out.isVirtual, false);
  });

  test('serviceResult with nextData=null', () => {
    const out = normalizeServiceResponse({ nextData: null });
    assert.equal(out.lumaData, null);
    assert.equal(out.lumaPageData, null);
  });

  test('nextData missing the deep .data path', () => {
    const out = normalizeServiceResponse({ nextData: { props: { pageProps: {} } } });
    assert.equal(out.lumaData, null);
    assert.ok(out.lumaPageData, 'persists the original nextData even when event missing');
  });

  test('handles the alternate pageProps.data shape', () => {
    // Some Luma pages serve __NEXT_DATA__ with .data nested directly under
    // pageProps rather than .initialData.data — both shapes are observed.
    const out = normalizeServiceResponse({
      nextData: {
        props: { pageProps: { data: { event: sampleEventData() } } },
      },
    });
    assert.equal(out.lumaData?.lumaEventId, 'evt-abc123');
  });
});


describe('normalizeServiceResponse — calendarData (Search/Category)', () => {
  test('opts.includeCalendarData omitted → no calendarData key', () => {
    const out = normalizeServiceResponse(wrap(sampleEventData(), {
      api_id: 'cal-1', name: 'Test cal', slug: 'test-cal',
    }));
    assert.equal(out.calendarData, undefined);
  });

  test('with includeCalendarData and calendar present', () => {
    const out = normalizeServiceResponse(
      wrap(sampleEventData(), { api_id: 'cal-1', name: 'Test cal', slug: 'test-cal' }),
      { includeCalendarData: true },
    );
    assert.deepEqual(out.calendarData, {
      apiId: 'cal-1',
      name: 'Test cal',
      slug: 'test-cal',
      url: 'https://lu.ma/test-cal',
    });
  });

  test('with includeCalendarData and no calendar in payload', () => {
    const out = normalizeServiceResponse(wrap(sampleEventData()), { includeCalendarData: true });
    assert.equal(out.calendarData, null);
  });

  test('calendar present but missing api_id → null calendarData (defensive)', () => {
    const out = normalizeServiceResponse(
      wrap(sampleEventData(), { name: 'no api_id', slug: 'x' }),
      { includeCalendarData: true },
    );
    assert.equal(out.calendarData, null);
  });

  test('calendar without slug → url is null', () => {
    const out = normalizeServiceResponse(
      wrap(sampleEventData(), { api_id: 'cal-1', name: 'No slug' }),
      { includeCalendarData: true },
    );
    assert.equal(out.calendarData.url, null);
  });
});
