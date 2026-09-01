import { describe, it, expect } from 'vitest';
import { aggregateRunModelCosts, shortModel } from '../admin/lib/run-costs';

describe('shortModel', () => {
  it('strips the claude- prefix only', () => {
    expect(shortModel('claude-sonnet-5')).toBe('sonnet-5');
    expect(shortModel('claude-haiku-4-5')).toBe('haiku-4-5');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(shortModel('gpt-5.2-codex')).toBe('gpt-5.2-codex');
  });
});

describe('aggregateRunModelCosts', () => {
  it('sums SDK per-model breakdowns across phases, sorted by spend', () => {
    const phases = [
      { phase: 'spec', model: 'claude-sonnet-5', cost_usd: 2.0, model_usage: {
        'claude-sonnet-5': { costUSD: 1.8 }, 'claude-haiku-4-5': { costUSD: 0.2 } } },
      { phase: 'implement', model: 'claude-sonnet-5', cost_usd: 3.0, model_usage: {
        'claude-sonnet-5': { costUSD: 2.9 }, 'claude-haiku-4-5': { costUSD: 0.1 } } },
    ];
    const { total, rows } = aggregateRunModelCosts(phases);
    expect(total).toBe(5.0);
    expect(rows).toEqual([
      { model: 'claude-sonnet-5', costUSD: 4.7 },
      { model: 'claude-haiku-4-5', costUSD: 0.3 },
    ]);
  });

  it('falls back to phase cost under the phase model when there is no breakdown (pre-018 rows)', () => {
    const phases = [
      { phase: 'spec', model: 'claude-opus-5', cost_usd: 1.5, model_usage: null },
      { phase: 'review', model: 'claude-opus-5', cost_usd: 0.5 },
    ];
    const { total, rows } = aggregateRunModelCosts(phases);
    expect(total).toBe(2.0);
    expect(rows).toEqual([{ model: 'claude-opus-5', costUSD: 2.0 }]);
  });

  it('attributes live heartbeat snapshots (null per-model costUSD) to the dominant usage model, even when the row has no model yet', () => {
    const phases = [
      { phase: 'implement', model: null, cost_usd: 8.44, model_usage: {
        'claude-sonnet-5': { input: 500, output: 1344, cacheRead: 29897356, costUSD: null },
        'claude-haiku-4-5-20251001': { input: 282, output: 72, cacheRead: 2078818, costUSD: null } } },
    ];
    const { total, rows } = aggregateRunModelCosts(phases);
    expect(total).toBe(8.44);
    expect(rows).toEqual([{ model: 'claude-sonnet-5', costUSD: 8.44 }]);
  });

  it('attributes a live snapshot to the phase model once it is set (issue #55 fix), not the dominant-usage fallback', () => {
    const phases = [
      { phase: 'implement', model: 'claude-sonnet-5', cost_usd: 6.89, model_usage: {
        'claude-sonnet-5': { input: 500, output: 1344, cacheRead: 29897356, costUSD: null } } },
      { phase: 'spec', model: 'claude-sonnet-5', cost_usd: 2.21, model_usage: {
        'claude-sonnet-5': { costUSD: 2.21 } } },
      { phase: 'review', model: 'claude-haiku-4-5', cost_usd: 0.64, model_usage: {
        'claude-haiku-4-5': { costUSD: 0.64 } } },
    ];
    const { total, rows } = aggregateRunModelCosts(phases);
    expect(total).toBe(9.74);
    expect(rows.find((r) => r.model === 'unattributed')).toBeUndefined();
    expect(rows).toEqual([
      { model: 'claude-sonnet-5', costUSD: 9.1 },
      { model: 'claude-haiku-4-5', costUSD: 0.64 },
    ]);
  });

  it('shortModel strips dated snapshot suffixes', () => {
    expect(aggregateRunModelCosts([])).toEqual({ total: 0, rows: [] });
  });

  it('ignores non-model phases and empty inputs', () => {
    expect(aggregateRunModelCosts([{ phase: 'intake', model: null, cost_usd: null }])).toEqual({ total: 0, rows: [] });
    expect(aggregateRunModelCosts([])).toEqual({ total: 0, rows: [] });
  });
});
