import { describe, it, expect } from 'vitest';
import { aggregateRunModelCosts, shortModel } from '../admin/lib/run-costs';

describe('shortModel', () => {
  it('strips the claude- prefix only', () => {
    expect(shortModel('claude-sonnet-5')).toBe('sonnet-5');
    expect(shortModel('claude-haiku-4-5')).toBe('haiku-4-5');
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

  it('attributes live heartbeat snapshots (null per-model costUSD) to the phase model via cost_usd', () => {
    const phases = [
      { phase: 'implement', model: 'claude-sonnet-5', cost_usd: 0.8, model_usage: {
        'claude-sonnet-5': { input: 10, output: 500, costUSD: null } } },
    ];
    const { total, rows } = aggregateRunModelCosts(phases);
    expect(total).toBe(0.8);
    expect(rows).toEqual([{ model: 'claude-sonnet-5', costUSD: 0.8 }]);
  });

  it('ignores non-model phases and empty inputs', () => {
    expect(aggregateRunModelCosts([{ phase: 'intake', model: null, cost_usd: null }])).toEqual({ total: 0, rows: [] });
    expect(aggregateRunModelCosts([])).toEqual({ total: 0, rows: [] });
  });
});
