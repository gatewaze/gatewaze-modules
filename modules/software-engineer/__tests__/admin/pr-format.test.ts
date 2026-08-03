/**
 * PR-board formatter tests. Fits the module's node vitest config
 * (`environment: 'node'`, no jsdom) — these helpers never touch React.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { timeAgo, formatSubmittedDate } from '../../admin/lib/pr-format';

describe('formatSubmittedDate', () => {
  it('returns "" for empty / null / undefined / unparseable input', () => {
    expect(formatSubmittedDate('')).toBe('');
    expect(formatSubmittedDate(null)).toBe('');
    expect(formatSubmittedDate(undefined)).toBe('');
    expect(formatSubmittedDate('not-a-date')).toBe('');
  });

  it('formats a known ISO timestamp to a human date-time', () => {
    // Assert on timezone-agnostic substrings (year + month) to dodge the
    // PST-midnight-rollover flake class from testing-patterns.md. Noon UTC
    // keeps the calendar day stable across common TZ offsets.
    const out = formatSubmittedDate('2026-07-30T12:14:00Z');
    expect(out).toContain('2026');
    expect(out).toContain('Jul');
    expect(out).not.toContain('Invalid');
  });

  it('is deterministic for the same input', () => {
    const iso = '2026-01-15T09:00:00Z';
    expect(formatSubmittedDate(iso)).toBe(formatSubmittedDate(iso));
  });
});

describe('timeAgo', () => {
  afterEach(() => vi.useRealTimers());

  it('reports minutes under an hour, flooring at 1m', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-03T12:00:00Z');
    vi.setSystemTime(now);
    expect(timeAgo('2026-08-03T11:30:00Z')).toBe('30m');
    // A few seconds ago still reads as at least 1m (never "0m").
    expect(timeAgo('2026-08-03T11:59:58Z')).toBe('1m');
  });

  it('reports hours under a day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
    expect(timeAgo('2026-08-03T07:00:00Z')).toBe('5h');
  });

  it('reports days at or beyond 24h', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
    expect(timeAgo('2026-07-30T12:00:00Z')).toBe('4d');
  });
});
