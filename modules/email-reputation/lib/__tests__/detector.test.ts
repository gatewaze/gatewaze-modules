import { describe, expect, it } from 'vitest';
import { detect, DEFAULT_THRESHOLDS } from '../detector';

describe('detect', () => {
  it('flags Gmail on the AAIF 8 Oct send (2.2% against about 34%)', () => {
    const alerts = detect([
      { provider: 'google', delivered: 36311, opened: 799 },
      { provider: 'other', delivered: 15968, opened: 5429 },
      { provider: 'microsoft', delivered: 1597, opened: 474 },
      { provider: 'yahoo', delivered: 895, opened: 329 },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].provider).toBe('google');
    expect(alerts[0].providerOpenRate).toBeCloseTo(0.022, 3);
    expect(alerts[0].baselineOpenRate).toBeGreaterThan(0.3);
  });

  it('flags Gmail on the tech.tickets 13 Oct sends (10% against 27%)', () => {
    const alerts = detect([
      { provider: 'google', delivered: 5953, opened: 617 },
      { provider: 'other', delivered: 3315, opened: 1039 },
    ]);
    expect(alerts.map((a) => a.provider)).toEqual(['google']);
  });

  it('does not flag a healthy MLOps send (Gmail 42% against 49%)', () => {
    expect(detect([
      { provider: 'google', delivered: 35783, opened: 15279 },
      { provider: 'other', delivered: 20000, opened: 9860 },
    ])).toEqual([]);
  });

  it('does not flag when every provider is low: the send is unopened, not filtered', () => {
    expect(detect([
      { provider: 'google', delivered: 5000, opened: 50 },
      { provider: 'other', delivered: 5000, opened: 300 },
    ])).toEqual([]);
  });

  it('needs enough delivered messages on both sides', () => {
    expect(detect([
      { provider: 'google', delivered: 499, opened: 5 },
      { provider: 'other', delivered: 5000, opened: 2000 },
    ])).toEqual([]);
    expect(detect([
      { provider: 'google', delivered: 5000, opened: 50 },
      { provider: 'other', delivered: 400, opened: 200 },
    ])).toEqual([]);
  });

  it('leaves Apple (automatic opens) and unknown out of the baseline and never flags them', () => {
    const alerts = detect([
      { provider: 'google', delivered: 5000, opened: 100 },
      { provider: 'apple', delivered: 5000, opened: 5000 },
      { provider: 'unknown', delivered: 5000, opened: 0 },
      { provider: 'other', delivered: 600, opened: 30 },
    ]);
    // Without Apple the baseline is 5%, below the 10% floor, so nothing fires.
    expect(alerts).toEqual([]);
  });

  it('can flag more than one provider', () => {
    const alerts = detect([
      { provider: 'google', delivered: 5000, opened: 50 },
      { provider: 'microsoft', delivered: 5000, opened: 50 },
      { provider: 'other', delivered: 5000, opened: 2000 },
    ]);
    expect(alerts.map((a) => a.provider).sort()).toEqual(['google', 'microsoft']);
  });

  it('uses the thresholds it is given', () => {
    const stats = [
      { provider: 'google', delivered: 1000, opened: 150 },
      { provider: 'other', delivered: 1000, opened: 400 },
    ];
    expect(detect(stats, DEFAULT_THRESHOLDS)).toEqual([]);
    expect(detect(stats, { ...DEFAULT_THRESHOLDS, maxRatio: 0.5 })).toHaveLength(1);
  });
});
