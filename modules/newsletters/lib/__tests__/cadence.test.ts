import { describe, it, expect } from 'vitest';
import { validateCadence, nextOccurrence, editionTitle, localDate } from '../cadence.js';

const weekly = { enabled: true, freq: 'weekly', byweekday: 'MO', hour: 9, minute: 0, timezone: 'America/Los_Angeles', create_lead_days: 4, research_lead_hours: 36 } as const;

describe('validateCadence', () => {
  it('accepts a weekly cadence and rejects bad shapes', () => {
    expect(validateCadence(weekly).errors).toEqual([]);
    expect(validateCadence({ ...weekly, byweekday: 'XX' }).errors.join()).toMatch(/byweekday/);
    expect(validateCadence({ ...weekly, timezone: 'Mars/Phobos' }).errors.join()).toMatch(/timezone/);
    expect(validateCadence({ ...weekly, freq: 'monthly' }).errors.join()).toMatch(/monthly needs/);
    expect(validateCadence({ ...weekly, freq: 'biweekly' }).errors.join()).toMatch(/anchor_date/);
  });
  it('requires creation to lead research', () => {
    expect(validateCadence({ ...weekly, create_lead_days: 1, research_lead_hours: 36 }).errors.join()).toMatch(/create_lead_days \* 24/);
    expect(validateCadence({ ...weekly, create_lead_days: 2, research_lead_hours: 36 }).errors).toEqual([]);
  });
});

describe('nextOccurrence', () => {
  it('weekly Monday 09:00 Los Angeles, across the DST change', () => {
    // Sat 2026-10-17 → Mon 2026-10-19 09:00 PDT = 16:00Z
    expect(nextOccurrence(weekly, new Date('2026-10-17T21:00:00Z')).toISOString()).toBe('2026-10-19T16:00:00.000Z');
    // After US DST ends (2026-11-01): Mon 2026-11-02 09:00 PST = 17:00Z
    expect(nextOccurrence(weekly, new Date('2026-10-31T21:00:00Z')).toISOString()).toBe('2026-11-02T17:00:00.000Z');
    // Exactly at the instant → the following week (strictly after)
    expect(nextOccurrence(weekly, new Date('2026-10-19T16:00:00Z')).toISOString()).toBe('2026-10-26T16:00:00.000Z');
  });
  it('biweekly anchors on a known issue date', () => {
    const bi = { ...weekly, freq: 'biweekly', anchor_date: '2026-10-05' } as const; // a Monday
    expect(nextOccurrence(bi, new Date('2026-10-06T00:00:00Z')).toISOString()).toBe('2026-10-19T16:00:00.000Z');
    expect(nextOccurrence(bi, new Date('2026-10-20T00:00:00Z')).toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });
  it('monthly by day clamps to the month end; by nth weekday', () => {
    const m31 = { ...weekly, freq: 'monthly', bymonthday: 31, timezone: 'UTC' } as const;
    expect(nextOccurrence(m31, new Date('2026-11-01T00:00:00Z')).toISOString()).toBe('2026-11-30T09:00:00.000Z');
    expect(nextOccurrence(m31, new Date('2026-12-01T00:00:00Z')).toISOString()).toBe('2026-12-31T09:00:00.000Z');
    const nth = { ...weekly, freq: 'monthly', bynthweekday: '2TU', timezone: 'UTC' } as const;
    expect(nextOccurrence(nth, new Date('2026-11-01T00:00:00Z')).toISOString()).toBe('2026-11-10T09:00:00.000Z');
  });
});

describe('editionTitle / localDate', () => {
  it('substitutes only the send_date token', () => {
    const at = new Date('2026-10-19T16:00:00Z');
    expect(editionTitle('Weekly Agentic — {{send_date:MMM D}}', at, 'America/Los_Angeles', 'x')).toBe('Weekly Agentic — Oct 19');
    expect(editionTitle('Issue {{send_date:YYYY-MM-DD}} {{evil}}', at, 'UTC', 'x')).toBe('Issue 2026-10-19 {{evil}}');
    expect(editionTitle(undefined, at, 'UTC', 'fallback')).toBe('fallback');
    expect(localDate(at, 'Asia/Tokyo').ymd).toBe('2026-10-20');
  });
});
