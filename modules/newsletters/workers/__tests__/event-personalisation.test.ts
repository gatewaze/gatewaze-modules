import { describe, it, expect } from 'vitest';
import {
  parseLocalConfig, parseVirtualConfig, stripEventMarkers, pickLoc, areaKey,
  renderEventsHtml, resolveLocalEvents, resolveVirtualEvents,
  type EventRow, type EventRpcClient,
} from '../event-personalisation.js';

const MILES_TO_KM = 1.60934;

function ev(partial: Partial<EventRow>): EventRow {
  return {
    id: 'id', event_id: 'e1', event_title: 'Event', event_start: '2026-08-06T18:00:00Z',
    event_timezone: 'America/Los_Angeles', event_city: 'San Francisco', event_slug: null,
    event_url: null, event_image: null, match_tier: 'geo', ...partial,
  };
}

describe('parseLocalConfig', () => {
  it('parses a marker and converts miles → km', () => {
    const html = `<!--gw-local-events:${JSON.stringify({ h: 'Near You', i: 'hi', m: 2, r: 50 })}-->{{local_events_block}}`;
    const cfg = parseLocalConfig(html);
    expect(cfg.heading).toBe('Near You');
    expect(cfg.intro).toBe('hi');
    expect(cfg.max).toBe(2);
    expect(cfg.radiusKm).toBeCloseTo(50 * MILES_TO_KM, 3);
  });
  it('falls back to defaults with no marker', () => {
    const cfg = parseLocalConfig('{{local_events_block}}');
    expect(cfg.heading).toBe('Upcoming Events Near You');
    expect(cfg.max).toBe(3);
    expect(cfg.radiusKm).toBeCloseTo(100 * MILES_TO_KM, 3);
  });
  it('falls back on malformed JSON', () => {
    const cfg = parseLocalConfig('<!--gw-local-events:{not json}-->');
    expect(cfg.heading).toBe('Upcoming Events Near You');
  });
  it('clamps max and radius to sane bounds', () => {
    const cfg = parseLocalConfig(`<!--gw-local-events:${JSON.stringify({ m: 999, r: 0 })}-->`);
    expect(cfg.max).toBe(20);
    expect(cfg.radiusKm).toBeCloseTo(1 * MILES_TO_KM, 3);
  });
});

describe('parseVirtualConfig', () => {
  it('parses and defaults', () => {
    expect(parseVirtualConfig('<!--gw-virtual-events:{"h":"V","m":4}-->').max).toBe(4);
    expect(parseVirtualConfig('x').heading).toBe('Upcoming Virtual Events');
    expect(parseVirtualConfig('x').max).toBe(5);
  });
});

describe('stripEventMarkers', () => {
  it('removes both markers but keeps the tokens', () => {
    const html = '<!--gw-local-events:{"m":1}-->{{local_events_block}}<!--gw-virtual-events:{"m":1}-->{{virtual_events_block}}';
    const out = stripEventMarkers(html);
    expect(out).not.toContain('gw-local-events');
    expect(out).not.toContain('gw-virtual-events');
    expect(out).toContain('{{local_events_block}}');
    expect(out).toContain('{{virtual_events_block}}');
  });
});

describe('pickLoc', () => {
  it('parses "lat,lng" location string', () => {
    expect(pickLoc({ location: '37.77,-122.41', city: 'SF' })).toEqual({ lat: 37.77, lon: -122.41, city: 'SF' });
  });
  it('reads separate lat/lon keys', () => {
    expect(pickLoc({ latitude: 40.7, longitude: -74 })).toEqual({ lat: 40.7, lon: -74, city: null });
  });
  it('city-only when no coords', () => {
    expect(pickLoc({ city: 'Berlin' })).toEqual({ lat: null, lon: null, city: 'Berlin' });
  });
  it('rejects out-of-range coords', () => {
    expect(pickLoc({ location: '999,999', city: 'X' })).toEqual({ lat: null, lon: null, city: 'X' });
  });
  it('empty attrs → all null', () => {
    expect(pickLoc({})).toEqual({ lat: null, lon: null, city: null });
    expect(pickLoc(null)).toEqual({ lat: null, lon: null, city: null });
  });
});

describe('areaKey', () => {
  it('coarse geo cell then city then null', () => {
    expect(areaKey({ lat: 37.774, lon: -122.419, city: 'SF' })).toBe('geo:37.8|-122.4');
    expect(areaKey({ lat: null, lon: null, city: 'Berlin' })).toBe('city:berlin');
    expect(areaKey({ lat: null, lon: null, city: null })).toBeNull();
  });
});

describe('renderEventsHtml (omission + content)', () => {
  it('returns empty string for an empty list (drives omission)', () => {
    expect(renderEventsHtml([], { heading: 'H', intro: '', portalBaseUrl: null })).toBe('');
  });
  it('renders heading, title, and a portal fallback URL', () => {
    const html = renderEventsHtml([ev({ event_id: 'evt42', event_title: 'MLOps Meetup', event_url: null })],
      { heading: 'Near You', intro: 'howdy', portalBaseUrl: 'https://mlops.community/' });
    expect(html).toContain('Near You');
    expect(html).toContain('howdy');
    expect(html).toContain('MLOps Meetup');
    expect(html).toContain('https://mlops.community/events/evt42');
  });
  it('prefers event_url when present', () => {
    const html = renderEventsHtml([ev({ event_url: 'https://x.io/e' })], { heading: 'H', intro: '', portalBaseUrl: 'https://p' });
    expect(html).toContain('https://x.io/e');
  });
  it('escapes HTML in titles', () => {
    const html = renderEventsHtml([ev({ event_title: '<script>x</script>' })], { heading: 'H', intro: '', portalBaseUrl: null });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('resolve* against a mock RPC client', () => {
  const rows: EventRow[] = [ev({ event_title: 'A' }), ev({ event_title: 'B' })];

  it('resolveLocalEvents forwards args and returns rows', async () => {
    let seen: Record<string, unknown> | null = null;
    const client: EventRpcClient = { rpc: async (_fn, args) => { seen = args; return { data: rows, error: null }; } };
    const out = await resolveLocalEvents(client, { lat: 1, lon: 2, city: 'SF' }, { heading: 'H', intro: '', max: 3, radiusKm: 160 }, '2026-01-01T00:00:00Z');
    expect(out).toHaveLength(2);
    expect(seen).toMatchObject({ p_lat: 1, p_lon: 2, p_city: 'SF', p_radius_km: 160, p_limit: 3 });
  });
  it('resolveLocalEvents short-circuits with no location', async () => {
    let called = false;
    const client: EventRpcClient = { rpc: async () => { called = true; return { data: [], error: null }; } };
    const out = await resolveLocalEvents(client, { lat: null, lon: null, city: null }, { heading: 'H', intro: '', max: 3, radiusKm: 160 }, 'now');
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
  it('resolve* return [] on RPC error', async () => {
    const client: EventRpcClient = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
    expect(await resolveVirtualEvents(client, { heading: 'H', intro: '', max: 5 }, 'now')).toEqual([]);
    expect(await resolveLocalEvents(client, { lat: 1, lon: 2, city: null }, { heading: 'H', intro: '', max: 3, radiusKm: 1 }, 'now')).toEqual([]);
  });
});
