// @ts-nocheck — vitest harness; the lib modules are @ts-nocheck'd already.
//
// Exercises computeSpendOverview: it must sum se_runs.cost_usd into 30d/7d totals and a
// desc-by-spend per-project rollup, and degrade to null (never throw) on any query failure —
// including a client that doesn't implement .from() at all, which is how a pre-migration-012
// instance shows up in the real overview-route mock.
import { describe, it, expect } from 'vitest';
import { computeSpendOverview, computeModelUsage } from '../cost.js';

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 24 * 3600 * 1000).toISOString();

// Supabase double: chainable filter builder that resolves to `result` when awaited.
function mockSupabase(result: { data?: unknown; error?: unknown }) {
  const from = () => {
    const b: any = {
      select() { return b; },
      not() { return b; },
      gte() { return b; },
      eq() { return b; },
      then(resolve: any, reject: any) {
        return Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject);
      },
    };
    return b;
  };
  return { from };
}

describe('computeSpendOverview', () => {
  it('sums 30d/7d totals and groups by project, sorted desc', async () => {
    const rows = [
      { cost_usd: 1.5, created_at: daysAgo(1), project_id: 'p1', project: { name: 'Alpha', avatar_emoji: '🚀' } },
      { cost_usd: 2.25, created_at: daysAgo(10), project_id: 'p1', project: { name: 'Alpha', avatar_emoji: '🚀' } },
      { cost_usd: 0.5, created_at: daysAgo(2), project_id: 'p2', project: [{ name: 'Beta', avatar_emoji: '🔥' }] },
    ];
    const sb = mockSupabase({ data: rows });
    const result = await computeSpendOverview(sb, null);
    expect(result.total_30d).toBeCloseTo(4.25);
    expect(result.total_7d).toBeCloseTo(2.0);
    expect(result.by_project).toEqual([
      { project_id: 'p1', name: 'Alpha', avatar_emoji: '🚀', total: 3.75 },
      { project_id: 'p2', name: 'Beta', avatar_emoji: '🔥', total: 0.5 },
    ]);
  });

  it('returns null when the query reports an error (e.g. missing cost_usd column)', async () => {
    const sb = mockSupabase({ error: { message: 'column se_runs.cost_usd does not exist' } });
    expect(await computeSpendOverview(sb, null)).toBeNull();
  });

  it('returns null when the client throws synchronously (no .from at all)', async () => {
    const sb = {};
    expect(await computeSpendOverview(sb, null)).toBeNull();
  });

  it('returns zeroed totals for an empty result set', async () => {
    const sb = mockSupabase({ data: [] });
    expect(await computeSpendOverview(sb, null)).toEqual({ total_30d: 0, total_7d: 0, by_project: [] });
  });
});

// rpc double for computeModelUsage: records the call and returns canned se_model_usage() rows.
function mockRpc(result: { data?: unknown; error?: unknown }) {
  const calls: { name: string; args: unknown }[] = [];
  return {
    calls,
    rpc(name: string, args: unknown) { calls.push({ name, args }); return Promise.resolve({ data: result.data ?? null, error: result.error ?? null }); },
  };
}

describe('computeModelUsage', () => {
  it('maps se_model_usage rows and passes the project + days through to the RPC', async () => {
    const sb = mockRpc({ data: [
      { model: 'claude-sonnet-5', phases: 12, tokens_input: 900, tokens_output: 270000, tokens_cache_read: 36900000, tokens_cache_creation: 2360000, cost_usd: 18.14 },
      { model: 'claude-haiku-4-5', phases: 3, tokens_input: 1800, tokens_output: 20, tokens_cache_read: 0, tokens_cache_creation: 0, cost_usd: 0.002 },
    ] });
    const rows = await computeModelUsage(sb, 'p1', 30);
    expect(sb.calls[0]).toEqual({ name: 'se_model_usage', args: { p_project: 'p1', p_days: 30 } });
    expect(rows[0]).toEqual({ model: 'claude-sonnet-5', phases: 12, input: 900, output: 270000, cacheRead: 36900000, cacheCreation: 2360000, cost: 18.14 });
    expect(rows[1].model).toBe('claude-haiku-4-5');
  });

  it('degrades to [] on RPC error or a missing-rpc client (pre-022 instance)', async () => {
    expect(await computeModelUsage(mockRpc({ error: { message: 'function se_model_usage does not exist' } }), null, 7)).toEqual([]);
    expect(await computeModelUsage({}, null, 7)).toEqual([]); // client with no .rpc() at all
  });
});
