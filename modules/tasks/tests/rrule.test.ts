import { describe, it, expect } from 'vitest';
import { parse, isValid, nextOccurrence, describe as describeRule } from '../lib/rrule';

describe('rrule.parse', () => {
  it('parses DAILY', () => {
    const r = parse('FREQ=DAILY;INTERVAL=2');
    expect(r.freq).toBe('DAILY');
    expect(r.interval).toBe(2);
  });

  it('parses WEEKLY+BYDAY', () => {
    const r = parse('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(r.byDay).toEqual(['MO', 'WE', 'FR']);
  });

  it('parses COUNT and UNTIL', () => {
    const r = parse('FREQ=DAILY;COUNT=5');
    expect(r.count).toBe(5);
    const u = parse('FREQ=DAILY;UNTIL=20260101');
    expect(u.until?.getUTCFullYear()).toBe(2026);
  });
});

describe('rrule.isValid', () => {
  it('returns true for valid rules', () => {
    expect(isValid('FREQ=DAILY')).toBe(true);
  });
  it('returns false for missing FREQ', () => {
    expect(isValid('INTERVAL=2')).toBe(false);
  });
});

describe('rrule.nextOccurrence', () => {
  it('weekly Mon/Wed/Fri after a Sunday → next Monday', () => {
    const next = nextOccurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR', new Date(Date.UTC(2026, 4, 17))); // Sun May 17
    expect(next).not.toBeNull();
    expect(next!.getUTCDay()).toBe(1); // Mon
  });

  it('respects UNTIL', () => {
    const r = nextOccurrence('FREQ=DAILY;UNTIL=20260101', new Date(Date.UTC(2026, 0, 1)));
    expect(r).toBeNull();
  });
});

describe('rrule.describe', () => {
  it('humanises weekly with BYDAY', () => {
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,FR')).toContain('Mon');
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,FR')).toContain('Fri');
  });

  it('handles daily interval', () => {
    expect(describeRule('FREQ=DAILY;INTERVAL=3')).toBe('Every 3 days');
  });
});
