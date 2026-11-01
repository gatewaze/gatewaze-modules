import { describe, expect, it } from 'vitest';
import { parseConfig, providerDailyLimit, providerId } from '../config';

describe('parseConfig', () => {
  it('has safe defaults', () => {
    expect(parseConfig({})).toEqual({
      recheckDays: 180, checksPerRun: 500, budgetMs: 120_000, dailyPaidLimit: 500,
      providerOrder: [], escalationProvider: null, compareProvider: null, comparePercent: 0, suppressInvalid: true,
    });
  });

  it('clamps numbers and reads strings from the settings form', () => {
    const c = parseConfig({ recheck_days: '1', checks_per_run: 99999, daily_paid_limit: '-5', compare_percent: '250', suppress_invalid: 'false' });
    expect(c.recheckDays).toBe(7);
    expect(c.checksPerRun).toBe(5000);
    expect(c.dailyPaidLimit).toBe(0);
    expect(c.comparePercent).toBe(100);
    expect(c.suppressInvalid).toBe(false);
  });

  it('caps the run budget well inside the 900-second lease', () => {
    expect(parseConfig({ budget_ms: 10_000_000 }).budgetMs).toBe(240_000);
    expect(parseConfig({ budget_ms: 1 }).budgetMs).toBe(10_000);
  });

  it('reads booleans from strings and provider lists from arrays', () => {
    expect(parseConfig({ suppress_invalid: 'true' }).suppressInvalid).toBe(true);
    expect(parseConfig({ suppress_invalid: 'nonsense' }).suppressInvalid).toBe(true);
    expect(parseConfig({ provider_order: ['debounce', 'kickbox'] }).providerOrder).toEqual(['email-verification-debounce', 'email-verification-kickbox']);
  });

  it('turns short provider names into module ids, without duplicates', () => {
    const c = parseConfig({ provider_order: 'debounce, Kickbox,email-verification-debounce,,', escalation_provider: 'bounceban' });
    expect(c.providerOrder).toEqual(['email-verification-debounce', 'email-verification-kickbox']);
    expect(c.escalationProvider).toBe('email-verification-bounceban');
  });
});

describe('providerId', () => {
  it('refuses anything that could point outside the module roots', () => {
    for (const bad of ['../etc', 'deb/ounce', 'email-verification-../../x', 'a b', '', 42]) {
      expect(providerId(bad)).toBeNull();
    }
  });
});

describe('providerDailyLimit', () => {
  it('is null when unset and clamped when set', () => {
    expect(providerDailyLimit({})).toBeNull();
    expect(providerDailyLimit({ daily_limit: '' })).toBeNull();
    expect(providerDailyLimit({ daily_limit: '250' })).toBe(250);
    expect(providerDailyLimit({ daily_limit: -1 })).toBe(0);
  });
});
