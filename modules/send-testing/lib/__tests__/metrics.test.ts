import { describe, it, expect } from 'vitest';
import {
  buildHistogram,
  computeRunResults,
  percentile,
  summariseAuth,
  summariseLatency,
  summariseSendLog,
} from '../metrics';

const T0 = '2026-09-01T10:00:00.000Z';
const at = (secondsAfterT0: number) =>
  new Date(Date.parse(T0) + secondsAfterT0 * 1000).toISOString();

describe('percentile', () => {
  it('uses nearest-rank rather than interpolating', () => {
    const values = [10, 20, 30, 40, 50];
    // Interpolation would return 44 for p90; nearest-rank returns a latency a
    // real message actually experienced.
    expect(percentile(values, 90)).toBe(50);
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 1)).toBe(10);
  });

  it('handles the empty case', () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe('summariseLatency', () => {
  it('pairs arrivals to sends by address', () => {
    const result = summariseLatency(
      [
        { recipient_email: 'st-000001@t.example.org', received_at: at(10) },
        { recipient_email: 'st-000002@t.example.org', received_at: at(30) },
      ],
      [
        { recipient_email: 'st-000001@t.example.org', sent_at: at(0), status: 'sent' },
        { recipient_email: 'st-000002@t.example.org', sent_at: at(0), status: 'sent' },
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.matched).toBe(2);
    expect(result!.max).toBe(30000);
    expect(result!.p50).toBe(10000);
  });

  it('is null for an external send with no send-side timestamps', () => {
    // The run still reports completion; latency would be a fabrication.
    const result = summariseLatency(
      [{ recipient_email: 'st-000001@t.example.org', received_at: at(10) }],
      [],
    );
    expect(result).toBeNull();
  });

  it('matches case-insensitively', () => {
    const result = summariseLatency(
      [{ recipient_email: 'ST-000001@T.example.org', received_at: at(5) }],
      [{ recipient_email: 'st-000001@t.example.org', sent_at: at(0), status: 'sent' }],
    );
    expect(result!.matched).toBe(1);
  });

  it('uses the earliest dispatch when a recipient was retried', () => {
    const result = summariseLatency(
      [{ recipient_email: 'a@t.example.org', received_at: at(100) }],
      [
        { recipient_email: 'a@t.example.org', sent_at: at(60), status: 'sent' },
        { recipient_email: 'a@t.example.org', sent_at: at(0), status: 'send_failed' },
      ],
    );
    expect(result!.max).toBe(100000);
  });

  it('drops negative deltas from clock skew rather than reporting them', () => {
    const result = summariseLatency(
      [
        { recipient_email: 'a@t.example.org', received_at: at(-5) },
        { recipient_email: 'b@t.example.org', received_at: at(10) },
      ],
      [
        { recipient_email: 'a@t.example.org', sent_at: at(0), status: 'sent' },
        { recipient_email: 'b@t.example.org', sent_at: at(0), status: 'sent' },
      ],
    );
    expect(result!.matched).toBe(1);
    expect(result!.max).toBe(10000);
  });

  it('is null when no arrival pairs with a send', () => {
    const result = summariseLatency(
      [{ recipient_email: 'ghost@t.example.org', received_at: at(10) }],
      [{ recipient_email: 'other@t.example.org', sent_at: at(0), status: 'sent' }],
    );
    expect(result).toBeNull();
  });
});

describe('summariseAuth', () => {
  it('counts only arrivals carrying verdicts', () => {
    const summary = summariseAuth([
      {
        recipient_email: 'a@t.example.org',
        received_at: at(1),
        headers_meta: { auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } },
      },
      {
        recipient_email: 'b@t.example.org',
        received_at: at(2),
        headers_meta: { auth: { spf: 'pass', dkim: 'fail', dmarc: 'fail' } },
      },
      { recipient_email: 'c@t.example.org', received_at: at(3), headers_meta: {} },
    ]);
    expect(summary).toEqual({ spf_pass: 2, dkim_pass: 1, dmarc_pass: 1, evaluated: 2 });
  });
});

describe('summariseSendLog', () => {
  it('folds the platform status vocabulary into four buckets', () => {
    const summary = summariseSendLog([
      { recipient_email: 'a@x', sent_at: null, status: 'queued' },
      { recipient_email: 'b@x', sent_at: null, status: 'delivered' },
      { recipient_email: 'c@x', sent_at: null, status: 'accepted' },
      { recipient_email: 'd@x', sent_at: null, status: 'bounced' },
      { recipient_email: 'e@x', sent_at: null, status: 'permanently_failed' },
      { recipient_email: 'f@x', sent_at: null, status: 'dropped' },
    ]);
    expect(summary).toEqual({ queued: 1, sent: 2, failed: 2, bounced: 1 });
  });

  it('is null when there is no send log at all', () => {
    expect(summariseSendLog([])).toBeNull();
  });
});

describe('buildHistogram', () => {
  it('buckets arrivals across the window', () => {
    const arrivals = [0, 1, 2, 30, 59].map((s) => ({
      recipient_email: `a${s}@t.example.org`,
      received_at: at(s),
    }));
    const buckets = buildHistogram(arrivals, at(0), at(60), 60);
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(5);
  });

  it('returns nothing for a zero-length or inverted window', () => {
    expect(buildHistogram([], at(0), at(0))).toEqual([]);
    expect(buildHistogram([], at(60), at(0))).toEqual([]);
  });

  it('ignores arrivals outside the window rather than clamping them in', () => {
    const buckets = buildHistogram(
      [
        { recipient_email: 'early@t.example.org', received_at: at(-100) },
        { recipient_email: 'inside@t.example.org', received_at: at(10) },
        { recipient_email: 'late@t.example.org', received_at: at(9999) },
      ],
      at(0),
      at(60),
    );
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });
});

describe('computeRunResults', () => {
  it('counts distinct recipients, not raw arrival rows', () => {
    // A duplicate delivery to one address is not extra completion.
    const results = computeRunResults({
      arrivals: [
        { recipient_email: 'a@t.example.org', received_at: at(1) },
        { recipient_email: 'a@t.example.org', received_at: at(2) },
        { recipient_email: 'b@t.example.org', received_at: at(3) },
      ],
      sendLog: [],
      expectedCount: 4,
      startedAt: at(0),
      endedAt: at(60),
    });
    expect(results.arrival_count).toBe(2);
    expect(results.completion_percent).toBe(50);
  });

  it('does not divide by zero when nothing was expected', () => {
    const results = computeRunResults({
      arrivals: [],
      sendLog: [],
      expectedCount: 0,
      startedAt: at(0),
      endedAt: at(60),
    });
    expect(results.completion_percent).toBe(0);
  });

  it('reports a realistic partial completion to two decimals', () => {
    const arrivals = Array.from({ length: 24985 }, (_, i) => ({
      recipient_email: `st-${String(i + 1).padStart(6, '0')}@t.example.org`,
      received_at: at(i % 3600),
    }));
    const results = computeRunResults({
      arrivals,
      sendLog: [],
      expectedCount: 25000,
      startedAt: at(0),
      endedAt: at(3600),
    });
    expect(results.completion_percent).toBe(99.94);
    expect(results.latency_ms).toBeNull();
  });
});
