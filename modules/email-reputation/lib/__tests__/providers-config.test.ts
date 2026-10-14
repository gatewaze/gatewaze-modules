import { describe, expect, it } from 'vitest';
import { isLookupableDomain, providerForMx, providerForMxHost } from '../providers';
import { parseConfig, safeSlackWebhook } from '../config';

describe('providerForMxHost', () => {
  it.each([
    ['aspmx.l.google.com.', 'google'],
    ['ALT1.ASPMX.L.GOOGLE.COM', 'google'],
    ['smtp.google.com', 'google'],
    ['example-com.mail.protection.outlook.com', 'microsoft'],
    ['mx1.hotmail.com', 'microsoft'],
    ['mta5.am0.yahoodns.net', 'yahoo'],
    ['mx01.mail.icloud.com', 'apple'],
    ['mxa-0012.gslb.pphosted.com', 'other'],
    ['eu-smtp-inbound-1.mimecast.com', 'other'],
    ['mx.sendgrid.net', 'other'],
    ['', 'unknown'],
  ])('%s -> %s', (host, provider) => {
    expect(providerForMxHost(host)).toBe(provider);
  });

  it('does not match a host that only contains a provider name', () => {
    expect(providerForMxHost('google.com.evil.example')).toBe('other');
    expect(providerForMxHost('notgoogle.com')).toBe('other');
  });
});

describe('providerForMx', () => {
  it('uses the preferred (lowest priority) record', () => {
    expect(providerForMx([
      { exchange: 'backup.mimecast.com', priority: 20 },
      { exchange: 'aspmx.l.google.com', priority: 1 },
    ])).toEqual({ provider: 'google', mxHost: 'aspmx.l.google.com' });
  });

  it('is unknown with no records', () => {
    expect(providerForMx([])).toEqual({ provider: 'unknown', mxHost: null });
  });
});

describe('isLookupableDomain', () => {
  it('accepts normal domains and rejects junk', () => {
    expect(isLookupableDomain('aaif.live')).toBe(true);
    expect(isLookupableDomain('mail.example.co.uk')).toBe(true);
    expect(isLookupableDomain('localhost')).toBe(false);
    expect(isLookupableDomain('bad domain.com')).toBe(false);
    expect(isLookupableDomain('-bad.com')).toBe(false);
    expect(isLookupableDomain('a'.repeat(250) + '.com')).toBe(false);
  });
});

describe('safeSlackWebhook', () => {
  it('accepts only https Slack incoming webhooks', () => {
    expect(safeSlackWebhook('https://hooks.slack.com/services/T0/B0/xyz')).toBe('https://hooks.slack.com/services/T0/B0/xyz');
    expect(safeSlackWebhook('http://hooks.slack.com/services/T0/B0/xyz')).toBe('');
    expect(safeSlackWebhook('https://hooks.slack.com.evil.example/services/x')).toBe('');
    expect(safeSlackWebhook('https://user:pw@hooks.slack.com/services/x')).toBe('');
    expect(safeSlackWebhook('https://hooks.slack.com:8443/services/x')).toBe('');
    expect(safeSlackWebhook('https://hooks.slack.com/other/x')).toBe('');
    expect(safeSlackWebhook('https://169.254.169.254/services/x')).toBe('');
    expect(safeSlackWebhook(42)).toBe('');
  });
});

describe('parseConfig', () => {
  it('uses defaults for an empty config', () => {
    const c = parseConfig({});
    expect(c.thresholds).toEqual({ minDelivered: 500, minBaselineRate: 0.1, maxRatio: 1 / 3 });
    expect(c).toMatchObject({ recentDays: 7, backfillDays: 120, budgetMs: 60000, domainLookupsPerRun: 300, slackWebhookUrl: '' });
  });

  it('clamps out-of-range and junk values', () => {
    const c = parseConfig({ budget_ms: 999999999, min_delivered: -5, max_open_rate_ratio: 'abc', backfill_days: '30' });
    expect(c.budgetMs).toBe(240000);
    expect(c.thresholds.minDelivered).toBe(50);
    expect(c.thresholds.maxRatio).toBeCloseTo(1 / 3);
    expect(c.backfillDays).toBe(30);
  });
});
