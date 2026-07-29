/**
 * Unit tests for settings + UA template substitution (spec §3.1, §8.3).
 */

import { afterEach, describe, it, expect } from 'vitest';
import {
  resolveSettings,
  resolveUserAgent,
  resolveResidentialEgress,
} from '../lib/settings.js';

describe('resolveSettings', () => {
  it('returns defaults when no overrides', () => {
    const s = resolveSettings({});
    expect(s.default_quota_requests_per_month).toBe(10000);
    expect(s.idempotency_ttl_seconds).toBe(300);
  });

  it('merges operator overrides', () => {
    const s = resolveSettings({ default_quota_requests_per_month: 50000 });
    expect(s.default_quota_requests_per_month).toBe(50000);
    expect(s.default_quota_browser_minutes_per_month).toBe(60); // unchanged
  });
});

describe('resolveUserAgent', () => {
  it('substitutes plain host', () => {
    const ua = resolveUserAgent(
      'GatewazeFetchBot/1.0 (+https://${GATEWAZE_INSTANCE_HOST}/fetch-bot)',
      'events.acme.com',
    );
    expect(ua).toBe('GatewazeFetchBot/1.0 (+https://events.acme.com/fetch-bot)');
  });

  it('strips leading scheme defensively', () => {
    const ua = resolveUserAgent(
      'Bot (+https://${GATEWAZE_INSTANCE_HOST}/x)',
      'https://events.acme.com',
    );
    expect(ua).toBe('Bot (+https://events.acme.com/x)');
  });

  it('rejects host that still contains :// after strip', () => {
    expect(() =>
      resolveUserAgent('${GATEWAZE_INSTANCE_HOST}', 'tcp://example.com'),
    ).toThrow();
  });
});

describe('resolveResidentialEgress (spec §6.1 precedence)', () => {
  const ENV = 'GATEWAZE_FETCH_RESIDENTIAL_EGRESS';
  afterEach(() => {
    delete process.env[ENV];
  });

  it('defaults off when nothing is set', () => {
    expect(resolveResidentialEgress(undefined, undefined)).toBe(false);
  });

  it('module config off maps proxy back to default (off)', () => {
    // resolved via defaults: use_residential_egress:false → off
    const s = resolveSettings({});
    expect(s.use_residential_egress).toBe(false);
    expect(resolveResidentialEgress(undefined, false)).toBe(false);
  });

  it('explicit call arg wins over config and env (arg true)', () => {
    process.env[ENV] = 'false';
    expect(resolveResidentialEgress(true, false)).toBe(true);
  });

  it('explicit call arg wins over config and env (arg false)', () => {
    process.env[ENV] = 'true';
    expect(resolveResidentialEgress(false, true)).toBe(false);
  });

  it('module config wins over env when no explicit arg', () => {
    process.env[ENV] = 'false';
    expect(resolveResidentialEgress(undefined, true)).toBe(true);
  });

  it('env default applies when arg and config are unset', () => {
    process.env[ENV] = 'true';
    expect(resolveResidentialEgress(undefined, undefined)).toBe(true);
  });

  it('env accepts 1/yes/on truthy forms', () => {
    for (const v of ['1', 'yes', 'on', 'TRUE']) {
      process.env[ENV] = v;
      expect(resolveResidentialEgress(undefined, undefined)).toBe(true);
    }
  });
});
