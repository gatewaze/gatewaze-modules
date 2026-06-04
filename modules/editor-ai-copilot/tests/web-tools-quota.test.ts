import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  injectAiCostModuleForTesting,
  __setAiCostModuleForTesting,
  readTodayUsage,
  shouldAllowToolCall,
} from '../lib/web-tools/quota.js';

/**
 * Build an injectable ai-cost stub. Tests configure the sum response,
 * bypassing the dynamic-import resolution entirely. The quota module is
 * read-only (the runner writes the rows), so the stub only needs
 * sumTodayToolUsage.
 */
function makeAiCostStub(sumResult: { callCount: number; costMicroUsd: number } = { callCount: 0, costMicroUsd: 0 }) {
  const stub = {
    sumTodayToolUsage: vi.fn(async () => sumResult),
  };
  return { stub };
}

const supabaseStub = {} as Parameters<typeof readTodayUsage>[0];

afterEach(() => {
  __setAiCostModuleForTesting(null);
});

describe('readTodayUsage', () => {
  it('returns zeros when ai-cost reports no rows', async () => {
    const { stub } = makeAiCostStub({ callCount: 0, costMicroUsd: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(stub as any);
    const r = await readTodayUsage(supabaseStub, 'web_search', 'newsletter-editor');
    expect(r).toEqual({ callCount: 0, costMicroUsd: 0 });
  });

  it('returns the summed counters when ai-cost reports rows', async () => {
    const { stub } = makeAiCostStub({ callCount: 5, costMicroUsd: 50_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(stub as any);
    const r = await readTodayUsage(supabaseStub, 'fetch_url', 'newsletter-editor');
    expect(r).toEqual({ callCount: 5, costMicroUsd: 50_000 });
  });

  it('queries with the right (use_case, provider, model) tuple', async () => {
    const { stub } = makeAiCostStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(stub as any);
    await readTodayUsage(supabaseStub, 'fetch_url', 'newsletter-editor');
    expect(stub.sumTodayToolUsage).toHaveBeenCalledWith(supabaseStub, {
      useCase: 'newsletter-editor',
      provider: 'scrapling',
      model: 'fetch_url:fast',
    });
  });

  it('fails open (returns zeros) when ai-cost is absent', async () => {
    __setAiCostModuleForTesting(null);
    const r = await readTodayUsage(supabaseStub, 'fetch_url', 'newsletter-editor');
    expect(r).toEqual({ callCount: 0, costMicroUsd: 0 });
  });
});

describe('shouldAllowToolCall', () => {
  it('allows when under quota and under cost budget', () => {
    const r = shouldAllowToolCall(
      { callCount: 5, costMicroUsd: 10_000 },
      { dailyMaxCalls: 100, dailyCostBudgetMicroUsd: 1_000_000 },
      10_000,
      5_000,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses when call quota would be at-or-over (next would exceed)', () => {
    const r = shouldAllowToolCall(
      { callCount: 100, costMicroUsd: 0 },
      { dailyMaxCalls: 100, dailyCostBudgetMicroUsd: null },
      0,
      0,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('quota_exceeded');
  });

  it('treats dailyMaxCalls=0 as unlimited', () => {
    const r = shouldAllowToolCall(
      { callCount: 5_000, costMicroUsd: 0 },
      { dailyMaxCalls: 0, dailyCostBudgetMicroUsd: null },
      0,
      0,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses when next call would push past cost budget', () => {
    const r = shouldAllowToolCall(
      { callCount: 10, costMicroUsd: 99_000 },
      { dailyMaxCalls: 1000, dailyCostBudgetMicroUsd: 100_000 },
      99_000,
      5_000,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cost_budget_exceeded');
  });

  it('treats dailyCostBudgetMicroUsd=null as no cap', () => {
    const r = shouldAllowToolCall(
      { callCount: 10, costMicroUsd: 999_999_999 },
      { dailyMaxCalls: 1000, dailyCostBudgetMicroUsd: null },
      999_999_999,
      999_999,
    );
    expect(r.ok).toBe(true);
  });
});
