import { describe, expect, it } from 'vitest';
import { makeBudget, orderProviders } from '../budget';

const p = (id: string, config: Record<string, unknown> = {}) => ({ id, config });

describe('makeBudget', () => {
  it('stops at the daily limit across providers, counting what was used today', () => {
    const b = makeBudget([{ provider: 'a', checks: 3 }, { provider: 'b', checks: 5 }], 10, [p('a'), p('b')]);
    expect(b.left()).toBe(2);
    expect(b.take('a')).toBe(true);
    expect(b.take('b')).toBe(true);
    expect(b.take('a')).toBe(false);
  });

  it('allows nothing when the limit is 0', () => {
    expect(makeBudget([], 0, [p('a')]).take('a')).toBe(false);
  });

  it("stops a provider at its own daily limit while others still have budget", () => {
    const b = makeBudget([{ provider: 'a', checks: 2 }], 100, [p('a', { daily_limit: 3 }), p('b')]);
    expect(b.take('a')).toBe(true);
    expect(b.take('a')).toBe(false);
    expect(b.take('b')).toBe(true);
  });

  it('gives back a check that produced no answer', () => {
    const b = makeBudget([], 1, [p('a')]);
    expect(b.take('a')).toBe(true);
    expect(b.take('a')).toBe(false);
    b.giveBack('a');
    expect(b.take('a')).toBe(true);
  });

  it('allows nothing when usage could not be read', () => {
    const b = makeBudget(null, 500, [p('a')]);
    expect(b.left()).toBe(0);
    expect(b.take('a')).toBe(false);
  });

  it('refuses a provider it does not know', () => {
    expect(makeBudget([], 10, [p('a')]).take('zzz')).toBe(false);
  });
});

describe('orderProviders', () => {
  const loaded = [p('email-verification-c'), p('email-verification-a'), p('email-verification-esc'), p('email-verification-cmp')];
  const none = { providerOrder: [], escalationProvider: null, compareProvider: null };

  it('with no order, uses every provider by id, leaving out escalation and compare', () => {
    const o = orderProviders(loaded, { ...none, escalationProvider: 'email-verification-esc', compareProvider: 'email-verification-cmp' });
    expect(o.primary.map((x) => x.id)).toEqual(['email-verification-a', 'email-verification-c']);
    expect(o.escalation?.id).toBe('email-verification-esc');
    expect(o.compare?.id).toBe('email-verification-cmp');
  });

  it('follows the order and drops ids that are not loaded', () => {
    const o = orderProviders(loaded, { ...none, providerOrder: ['email-verification-c', 'email-verification-missing', 'email-verification-esc'], escalationProvider: 'email-verification-esc' });
    expect(o.primary.map((x) => x.id)).toEqual(['email-verification-c', 'email-verification-esc']);
  });

  it('returns null for an escalation provider that is not loaded', () => {
    expect(orderProviders(loaded, { ...none, escalationProvider: 'email-verification-nope' }).escalation).toBeNull();
  });
});
