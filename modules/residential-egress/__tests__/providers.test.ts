import { describe, it, expect } from 'vitest';
import { buildProxyUrl, newSessionId, PROVIDER_DEFAULTS, type ProxyCreds } from '../lib/providers.js';

const base = (provider: any, extra: Partial<ProxyCreds> = {}): ProxyCreds =>
  ({ provider, username: 'u', password: 'p', ...extra });

describe('buildProxyUrl — per-provider session/country conventions', () => {
  it('dataimpulse encodes country + sticky session on the username', () => {
    const url = buildProxyUrl(base('dataimpulse'), { sessionId: 'abc123', country: 'US' });
    expect(url).toBe('http://u__cr.us__sid.abc123:p@gw.dataimpulse.com:823');
  });

  it('rayobyte appends session + sessTime with dashes', () => {
    const url = buildProxyUrl(base('rayobyte', { session_minutes: 15 }), { sessionId: 'abc123', country: 'us' });
    expect(url).toBe('http://u-country-us-session-abc123-sessTime-15:p@gw.rayobyte.com:8080');
  });

  it('brightdata builds brd-customer-…-zone-… and uses the configured zone', () => {
    const url = buildProxyUrl(base('brightdata', { zone: 'resi', gateway_host: 'brd.superproxy.io' }), { sessionId: 'abc123' });
    expect(url).toBe('http://brd-customer-u-zone-resi-session-abc123:p@brd.superproxy.io:22225');
  });

  it('oxylabs uses customer- prefix + sessid + sesstime in seconds', () => {
    const url = buildProxyUrl(base('oxylabs', { session_minutes: 10 }), { sessionId: 'abc123', country: 'gb' });
    expect(url).toBe('http://customer-u-cc-gb-sessid-abc123-sesstime-600:p@pr.oxylabs.io:7777');
  });

  it('webshare upper-cases country and uses rotate-<sid> (or bare rotate)', () => {
    expect(buildProxyUrl(base('webshare'), { sessionId: 'abc123', country: 'us' }))
      .toBe('http://u-CC-US-rotate-abc123:p@p.webshare.io:80');
    expect(buildProxyUrl(base('webshare'), { sessionId: null }))
      .toBe('http://u-rotate:p@p.webshare.io:80');
  });

  it('iproyal puts flags on the PASSWORD with underscores', () => {
    const url = buildProxyUrl(base('iproyal', { session_minutes: 10 }), { sessionId: 'abc123', country: 'us' });
    expect(url).toBe('http://u:p_country-us_session-abc123_lifetime-10m@geo.iproyal.com:12321');
  });

  it('decodo uses user- prefix', () => {
    const url = buildProxyUrl(base('decodo'), { sessionId: 'abc123', country: 'us' });
    expect(url).toBe('http://user-u-country-us-session-abc123:p@gate.decodo.com:7000');
  });

  it('honours gateway host/port overrides and default_country', () => {
    const url = buildProxyUrl(base('dataimpulse', { gateway_host: 'x.example', gateway_port: 9000, default_country: 'de' }), { sessionId: 's' });
    expect(url).toBe('http://u__cr.de__sid.s:p@x.example:9000');
  });

  it('rotating (no sessionId) omits the sticky suffix', () => {
    expect(buildProxyUrl(base('dataimpulse'), {})).toBe('http://u:p@gw.dataimpulse.com:823');
  });

  it('percent-encodes credentials with special chars', () => {
    const url = buildProxyUrl(base('dataimpulse', { username: 'a@b', password: 'p:s@w' }), {});
    expect(url).toBe('http://a%40b:p%3As%40w@gw.dataimpulse.com:823');
  });

  it('throws for none / missing creds', () => {
    expect(() => buildProxyUrl(base('none'), {})).toThrow(/none/);
    expect(() => buildProxyUrl({ provider: 'dataimpulse', username: '', password: '' }, {})).toThrow(/username and password/);
  });
});

describe('newSessionId', () => {
  it('is 12 hex chars and varies', () => {
    let n = 0;
    const rand = () => (n++ % 7) / 7 + 0.01;
    const a = newSessionId(rand);
    const b = newSessionId(rand);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('PROVIDER_DEFAULTS', () => {
  it('covers every non-none provider', () => {
    for (const p of ['dataimpulse', 'rayobyte', 'brightdata', 'oxylabs', 'webshare', 'iproyal', 'decodo'] as const) {
      expect(PROVIDER_DEFAULTS[p]).toBeTruthy();
    }
  });
});
