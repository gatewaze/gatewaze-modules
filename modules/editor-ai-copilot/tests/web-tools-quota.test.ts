import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bumpTodayUsage,
  injectAiCostModuleForTesting,
  __setAiCostModuleForTesting,
  readTodayUsage,
  shouldAllowToolCall,
} from '../lib/web-tools/quota.js';

/**
 * Build an injectable ai-cost stub. Tests configure the sum response
 * and inspect the recordUsage calls, bypassing the dynamic-import
 * resolution entirely.
 */
function makeAiCostStub(sumResult: { callCount: number; costMicroUsd: number } = { callCount: 0, costMicroUsd: 0 }) {
  const calls: Array<{
    provider: string;
    model: string;
    kind: string;
    costMicroUsdOverride: number;
    useCase: string;
  }> = [];
  const stub = {
    sumTodayToolUsage: vi.fn(async () => sumResult),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recordUsage: vi.fn(async (_supabase: unknown, event: any) => {
      calls.push(event);
      return event;
    }),
  };
  return { stub, calls };
}

const supabaseStub = {} as Parameters<typeof bumpTodayUsage>[0];

afterEach(() => {
  __setAiCostModuleForTesting(null);
});

describe('readTodayUsage', () => {
  it('returns zeros when ai-cost reports no rows', async () => {
    const { stub } = makeAiCostStub({ callCount: 0, costMicroUsd: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(stub as any);
    const r = await readTodayUsage(supabaseStub, 'web_search');
    expect(r).toEqual({ callCount: 0, costMicroUsd: 0 });
  });

  it('returns the summed counters when ai-cost reports rows', async () => {
    const { stub } = makeAiCostStub({ callCount: 5, costMicroUsd: 50_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(stub as any);
    const r = await readTodayUsage(supabaseStub, 'fetch_url');
    expect(r).toEqual({ callCount: 5, costMicroUsd: 50_000 });
  });

  it('queries with the right (use_case, provider, model) tuple', async () => {
    const { stub } = makeAiCostStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(stub as any);
    await readTodayUsage(supabaseStub, 'fetch_url');
    expect(stub.sumTodayToolUsage).toHaveBeenCalledWith(supabaseStub, {
      useCase: 'editor-ai-copilot',
      provider: 'scrapling',
      model: 'fetch_url:fast',
    });
  });
});

describe('bumpTodayUsage', () => {
  it('writes one recordUsage row per callDelta', async () => {
    const { stub, calls } = makeAiCostStub({ callCount: 1, costMicroUsd: 10_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(stub as any);

    const r = await bumpTodayUsage(supabaseStub, 'web_search', 1, 10_000);
    expect(r).toEqual({ callCount: 1, costMicroUsd: 10_000 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      useCase: 'editor-ai-copilot',
      provider: 'anthropic',
      model: 'web_search',
      kind: 'tool',
      costMicroUsdOverride: 10_000,
    });
  });

  it('writes N rows when callDelta=N (batched web_search count)', async () => {
    const { stub, calls } = makeAiCostStub({ callCount: 3, costMicroUsd: 30_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(stub as any);

    await bumpTodayUsage(supabaseStub, 'web_search', 3, 30_000);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.costMicroUsdOverride).toBe(10_000);
  });

  it('maps fetch_url to (scrapling, fetch_url:fast)', async () => {
    const { stub, calls } = makeAiCostStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(stub as any);

    await bumpTodayUsage(supabaseStub, 'fetch_url', 1, 5_000);
    expect(calls[0]).toMatchObject({
      provider: 'scrapling',
      model: 'fetch_url:fast',
    });
  });

  it('fails open (returns zeros) when ai-cost is absent', async () => {
    __setAiCostModuleForTesting(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injectAiCostModuleForTesting(null as any);
    const r = await bumpTodayUsage(supabaseStub, 'fetch_url', 1, 5_000);
    expect(r.callCount).toBe(0);
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
