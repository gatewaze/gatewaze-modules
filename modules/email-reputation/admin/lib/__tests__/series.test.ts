import { describe, expect, it } from 'vitest';
import { cellsBySend, domainsByRecency, formatRate } from '../series';

describe('cellsBySend', () => {
  it('folds providers outside the chart set into other and skips apple and unknown', () => {
    const cells = cellsBySend([
      { send_kind: 'newsletter', send_id: 'a', provider: 'google', delivered: 1000, opened: 20 },
      { send_kind: 'newsletter', send_id: 'a', provider: 'other', delivered: 500, opened: 150 },
      { send_kind: 'newsletter', send_id: 'a', provider: 'apple', delivered: 300, opened: 300 },
      { send_kind: 'newsletter', send_id: 'a', provider: 'unknown', delivered: 50, opened: 0 },
    ]);
    const row = cells.get('newsletter:a')!;
    expect(row.google).toEqual({ delivered: 1000, opened: 20, rate: 0.02 });
    expect(row.other).toEqual({ delivered: 500, opened: 150, rate: 0.3 });
    expect(row.yahoo.rate).toBeNull();
  });
});

describe('domainsByRecency', () => {
  it('orders domains by their latest send', () => {
    expect(domainsByRecency([
      { send_kind: 'newsletter', send_id: '1', sending_domain: 'news.mlops.community', send_label: null, send_started_at: '2026-08-20T00:00:00Z' },
      { send_kind: 'newsletter', send_id: '2', sending_domain: 'aaif.live', send_label: null, send_started_at: '2026-10-08T00:00:00Z' },
      { send_kind: 'newsletter', send_id: '3', sending_domain: 'news.mlops.community', send_label: null, send_started_at: '2026-06-25T00:00:00Z' },
    ])).toEqual(['aaif.live', 'news.mlops.community']);
  });
});

describe('formatRate', () => {
  it('shows a decimal below 10%', () => {
    expect(formatRate(0.022)).toBe('2.2%');
    expect(formatRate(0.337)).toBe('34%');
    expect(formatRate(null)).toBe('n/a');
  });
});
