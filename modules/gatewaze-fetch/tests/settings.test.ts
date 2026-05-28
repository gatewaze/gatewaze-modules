/**
 * Unit tests for settings + UA template substitution (spec §3.1, §8.3).
 */

import { describe, it, expect } from 'vitest';
import { resolveSettings, resolveUserAgent } from '../lib/settings.js';

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
