import { describe, it, expect } from 'vitest';
import {
  isConfigured, credsFromConfig, parseAllowlist, hostAllowed, resolveEgress, freshProxyUrl, credsFromConfig as _c,
  type EgressModuleConfig,
} from '../lib/egress.js';

const cfg = (o: Partial<EgressModuleConfig>): EgressModuleConfig => o;

describe('isConfigured', () => {
  it('needs a real provider + username + password', () => {
    expect(isConfigured(null)).toBe(false);
    expect(isConfigured(cfg({ provider: 'none' }))).toBe(false);
    expect(isConfigured(cfg({ provider: 'dataimpulse' }))).toBe(false);
    expect(isConfigured(cfg({ provider: 'dataimpulse', proxy_username: 'u' }))).toBe(false);
    expect(isConfigured(cfg({ provider: 'dataimpulse', proxy_username: 'u', proxy_password: 'p' }))).toBe(true);
  });
});

describe('credsFromConfig', () => {
  it('maps config fields to ProxyCreds and coerces numeric strings', () => {
    const creds = credsFromConfig(cfg({
      provider: 'dataimpulse', proxy_username: 'u', proxy_password: 'p',
      gateway_port: '823', session_minutes: '15', default_country: 'us',
    }));
    expect(creds).toMatchObject({ provider: 'dataimpulse', username: 'u', password: 'p', gateway_port: 823, session_minutes: 15, default_country: 'us' });
  });
  it('returns null when not configured', () => {
    expect(credsFromConfig(cfg({ provider: 'none' }))).toBeNull();
  });
});

describe('host allowlist', () => {
  it('parses comma list, suffix-matches, and allows all when empty', () => {
    const al = parseAllowlist(cfg({ host_allowlist: 'youtube.com, YouTu.be ,googlevideo.com' }));
    expect(al).toEqual(['youtube.com', 'youtu.be', 'googlevideo.com']);
    expect(hostAllowed('www.youtube.com', al)).toBe(true);
    expect(hostAllowed('youtube.com', al)).toBe(true);
    expect(hostAllowed('evil.com', al)).toBe(false);
    expect(hostAllowed('anything.com', [])).toBe(true);
  });
});

describe('resolveEgress', () => {
  const mkSupabase = (config: any) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: config ? { config } : null }) }) }) }),
  });

  it('resolves configured creds + allowlist + cap from the DB row', async () => {
    const r = await resolveEgress(mkSupabase({
      provider: 'dataimpulse', proxy_username: 'u', proxy_password: 'p',
      host_allowlist: 'youtube.com', daily_gb_cap: '5',
    }) as any);
    expect(r.configured).toBe(true);
    expect(r.creds?.provider).toBe('dataimpulse');
    expect(r.hostAllowlist).toEqual(['youtube.com']);
    expect(r.dailyGbCap).toBe(5);
  });

  it('returns not-configured on a missing row and never throws on DB error', async () => {
    expect((await resolveEgress(mkSupabase(null) as any)).configured).toBe(false);
    const throwing = { from: () => { throw new Error('boom'); } };
    const r = await resolveEgress(throwing as any);
    expect(r.configured).toBe(false);
    expect(r.creds).toBeNull();
  });
});

describe('freshProxyUrl', () => {
  it('produces a sticky URL with a fresh session id, or null when unconfigured', () => {
    const creds = credsFromConfig(cfg({ provider: 'dataimpulse', proxy_username: 'u', proxy_password: 'p' }));
    const out = freshProxyUrl(creds);
    expect(out?.proxyUrl).toMatch(/^http:\/\/u__sid\.[0-9a-f]{12}:p@gw\.dataimpulse\.com:823$/);
    expect(freshProxyUrl(null)).toBeNull();
  });
});
