/**
 * Tests for the GatewazePortalEventsScraper helpers.
 *
 * The two detail payloads are trimmed copies of what
 * https://api.aaif.live/api/portal/events/<id> returned on 2026-10-12: a
 * Luma-hosted chapter meetup and a virtual summit whose body is page_content.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanEventHtml,
  isPublicHttpsUrl,
  mapPortalEvent,
  parseEventTypeMap,
  parseLatLng,
  resolveSource,
} from '../gatewaze-portal-events.js';

const SCREENSHOT = 'https://ktkkanmhbygivyzzyfex.supabase.co/storage/v1/object/public/media/event-previews/n8z5q0.png';

const LUMA_MEETUP = {
  id: 'b8c5d860-1f3e-487d-9a18-dad6e0880220',
  event_id: 'n8z5q0',
  event_title: 'AAIF Berlin · Small Language Models Night at Distil Labs',
  event_start: '2026-10-15T16:00:00+00:00',
  event_end: '2026-10-15T19:00:00+00:00',
  event_timezone: 'Europe/Berlin',
  event_city: 'Berlin',
  event_region: 'eu',
  event_country_code: 'DE',
  event_location: '52.5305068,13.4114583',
  venue_address: 'Schönhauser Allee 10-11',
  event_description: null,
  luma_processed_html: '<p>Join us for an evening on <strong>small models</strong>.</p><script>alert(1)</script>',
  event_link: 'https://luma.com/3q4cjah8',
  screenshot_url: SCREENSHOT,
  enable_native_registration: false,
  luma_event_id: 'evt-OvhXAY5eZsTt6pt',
  event_type: 'community-event',
  page_content: null,
};

const VIRTUAL_SUMMIT = {
  event_id: 'yw4bd8',
  event_title: 'Accuracy & Reliability of AI Agents: Virtual Summit',
  event_start: '2026-10-15T15:00:00.671+00:00',
  event_end: '2026-10-15T17:00:15.682+00:00',
  event_timezone: 'US/Pacific',
  event_city: 'Online',
  event_region: '',
  event_country_code: '',
  event_location: null,
  event_link: 'https://home.mlops.community/public/events/accuracy-and-reliability-of-ai-agents-virtual-summit-77nje0s530',
  screenshot_url: SCREENSHOT,
  enable_native_registration: false,
  luma_event_id: null,
  event_type: 'virtual',
  page_content: '<p>As AI agents move from demos into real-world workflows, accuracy and reliability decide whether they ship.</p>',
};

const OPTS = {
  portalOrigin: 'https://aaif.live',
  sourceKey: 'aaif.live',
  scraperName: 'AAIF portal events',
  eventTypeMap: parseEventTypeMap(undefined),
};

describe('resolveSource', () => {
  test('derives the portal from the API host', () => {
    assert.deepEqual(resolveSource('https://api.aaif.live', undefined), {
      apiOrigin: 'https://api.aaif.live',
      portalOrigin: 'https://aaif.live',
      sourceKey: 'aaif.live',
    });
  });

  test('uses an explicit portal URL', () => {
    const r = resolveSource('https://api.tech.tickets/', 'https://www.tech.tickets/events');
    assert.equal(r.portalOrigin, 'https://www.tech.tickets');
    assert.equal(r.sourceKey, 'www.tech.tickets');
  });

  for (const [label, url] of [
    ['http', 'http://api.aaif.live'],
    ['localhost', 'https://localhost'],
    ['IPv4 literal', 'https://10.0.0.5'],
    ['decimal IPv4', 'https://167772165'],
    ['IPv6 literal', 'https://[::1]'],
    ['cluster service name', 'https://aaif-api.gatewaze.svc.cluster.local'],
    ['credentials', 'https://user:pw@api.aaif.live'],
    ['odd port', 'https://api.aaif.live:8443'],
    ['empty', ''],
  ]) {
    test(`rejects a ${label} base_url`, () => {
      assert.throws(() => resolveSource(url, undefined));
    });
  }

  test('rejects an internal portal URL', () => {
    assert.throws(() => resolveSource('https://api.aaif.live', 'https://127.0.0.1'));
  });
});

describe('mapPortalEvent', () => {
  test('maps a Luma meetup with its Luma id, coordinates and type', () => {
    const { event, skip } = mapPortalEvent(LUMA_MEETUP, null, OPTS);
    assert.equal(skip, undefined);
    assert.equal(event.eventLink, 'https://luma.com/3q4cjah8');
    assert.equal(event.lumaEventId, 'evt-OvhXAY5eZsTt6pt');
    assert.equal(event.sourceEventId, 'portal:aaif.live:n8z5q0');
    assert.equal(event.eventType, 'meetup');
    assert.deepEqual(event.coordinates, { lat: 52.5305068, lng: 13.4114583 });
    assert.equal(event.eventCountryCode, 'DE');
    assert.equal(event.venueAddress, 'Schönhauser Allee 10-11');
    assert.equal(event.coverImageUrl, SCREENSHOT);
    assert.equal(event.isVirtual, false);
  });

  test('uses Luma HTML as the body and strips scripts', () => {
    const { event } = mapPortalEvent(LUMA_MEETUP, null, OPTS);
    assert.ok(event.pageContentHtml.includes('<strong>small models</strong>'));
    assert.ok(!event.pageContentHtml.includes('<script'));
    assert.equal(event.eventDescription, 'Join us for an evening on small models .');
  });

  test('maps a virtual event to webinar and keeps page_content', () => {
    const { event } = mapPortalEvent(VIRTUAL_SUMMIT, null, OPTS);
    assert.equal(event.eventType, 'webinar');
    assert.equal(event.isVirtual, true);
    assert.equal(event.lumaEventId, null);
    assert.equal(event.eventLocation, '');
    assert.ok(event.pageContentHtml.startsWith('<p>As AI agents'));
  });

  test('links to the source portal page when the source brand runs registration', () => {
    const { event } = mapPortalEvent({ ...LUMA_MEETUP, enable_native_registration: true }, null, OPTS);
    assert.equal(event.eventLink, 'https://aaif.live/events/n8z5q0');
  });

  test('links to the source portal page when the outside link is not a web URL', () => {
    const { event } = mapPortalEvent({ ...LUMA_MEETUP, event_link: 'javascript:alert(1)' }, null, OPTS);
    assert.equal(event.eventLink, 'https://aaif.live/events/n8z5q0');
  });

  test('falls back to the listing row for fields the detail lacks', () => {
    const { event } = mapPortalEvent({ event_id: 'n8z5q0' }, LUMA_MEETUP, OPTS);
    assert.equal(event.eventTitle, LUMA_MEETUP.event_title);
  });

  test('passes an unmapped type through', () => {
    const { event } = mapPortalEvent({ ...LUMA_MEETUP, event_type: 'workshop' }, null, OPTS);
    assert.equal(event.eventType, 'workshop');
  });

  test('does not resolve prototype members as a type mapping', () => {
    const { event } = mapPortalEvent({ ...LUMA_MEETUP, event_type: 'constructor' }, null, OPTS);
    assert.equal(event.eventType, 'constructor');
  });

  test('drops a malformed Luma id rather than deduping on it', () => {
    const { event } = mapPortalEvent({ ...LUMA_MEETUP, luma_event_id: "evt-x' or 1=1" }, null, OPTS);
    assert.equal(event.lumaEventId, null);
  });

  for (const [label, patch, reason] of [
    ['an invalid event_id', { event_id: '../../admin' }, 'invalid event_id'],
    ['no title', { event_title: '  ' }, 'no title'],
    ['no start date', { event_start: 'soon' }, 'no start date'],
    ['no card image', { screenshot_url: null, event_logo: null }, 'no usable card image'],
    ['an internal card image', { screenshot_url: 'https://169.254.169.254/latest/meta-data' }, 'no usable card image'],
    ['an http card image', { screenshot_url: 'http://example.com/a.png' }, 'no usable card image'],
  ]) {
    test(`skips an event with ${label}`, () => {
      assert.deepEqual(mapPortalEvent({ ...LUMA_MEETUP, ...patch }, null, OPTS), { skip: reason });
    });
  }
});

describe('parseEventTypeMap', () => {
  test('applies source=target entries over the defaults', () => {
    const m = parseEventTypeMap(['virtual=conference', 'hackathon-day=hackathon', 'bad', '=x', 'y=']);
    assert.equal(m.virtual, 'conference');
    assert.equal(m['hackathon-day'], 'hackathon');
    assert.equal(m['community-event'], 'meetup');
    assert.ok(!Object.hasOwn(m, 'bad'));
    assert.ok(!Object.hasOwn(m, 'y'));
  });

  test('accepts an object', () => {
    assert.equal(parseEventTypeMap({ forum: 'meetup' }).forum, 'meetup');
  });
});

describe('cleanEventHtml', () => {
  test('removes handlers and script URLs', () => {
    const out = cleanEventHtml('<p onclick="x()">Hi <a href="javascript:alert(1)">a</a> <a href=\'data:text/html,x\'>b</a> <img src=x onerror=alert(1)></p><style>p{}</style><iframe src="https://x"></iframe>');
    assert.ok(!/onclick|onerror|javascript:|data:|<style|<iframe/i.test(out), out);
    assert.ok(out.includes('Hi'));
  });
});

describe('isPublicHttpsUrl', () => {
  test('accepts the AAIF storage host', () => {
    assert.equal(isPublicHttpsUrl(SCREENSHOT), true);
  });
  test('rejects hex-encoded IPs', () => {
    assert.equal(isPublicHttpsUrl('https://0x7f000001/x'), false);
  });
});

describe('parseLatLng', () => {
  test('rejects out-of-range and partial values', () => {
    assert.equal(parseLatLng('91,0'), null);
    assert.equal(parseLatLng('1,'), null);
    assert.equal(parseLatLng('a,b'), null);
    assert.deepEqual(parseLatLng(' 1.5 , -2 '), { lat: 1.5, lng: -2 });
  });
});
