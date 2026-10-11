import { describe, it, expect } from 'vitest';
import { MAX_CLOSES_HOURS, MAX_PER_GUEST, boothClosesAt, mayGenerate, readLimits } from '../booth-limits.js';

const START = '2026-09-25T13:30:00Z';
const at = (s: string) => Date.parse(s);
const OPEN = { closesHours: null, maxPerGuest: null };

describe('what an organiser has set', () => {
  it('is nothing until they set it', () => {
    for (const row of [null, {}, { booth_closes_hours: null }, { booth_closes_hours: 0 }, { booth_max_per_guest: 0 }]) {
      expect(readLimits(row)).toEqual(OPEN);
    }
  });

  it('is read as whole numbers, within what is sane', () => {
    expect(readLimits({ booth_closes_hours: 48.7, booth_max_per_guest: 10.2 }))
      .toEqual({ closesHours: 48, maxPerGuest: 10 });
    // A typo cannot leave it open for a year, or hand out thousands.
    expect(readLimits({ booth_closes_hours: 99999, booth_max_per_guest: 99999 }))
      .toEqual({ closesHours: MAX_CLOSES_HOURS, maxPerGuest: MAX_PER_GUEST });
    expect(readLimits({ booth_closes_hours: 'soon', booth_max_per_guest: -5 })).toEqual(OPEN);
  });
});

describe('when the booth closes', () => {
  it('is that many hours after the event starts', () => {
    expect(boothClosesAt({ ...OPEN, closesHours: 24 }, START)).toBe(at('2026-09-26T13:30:00Z'));
  });

  it('is never, without a closing time or a usable start', () => {
    expect(boothClosesAt(OPEN, START)).toBeNull();
    expect(boothClosesAt({ ...OPEN, closesHours: 24 }, null)).toBeNull();
    expect(boothClosesAt({ ...OPEN, closesHours: 24 }, 'whenever')).toBeNull();
  });
});

describe('whether a guest may have another made', () => {
  const may = (limits, now: string, made = 0) =>
    mayGenerate({ limits, eventStart: START, now: at(now), made });

  it('lets anyone through while nothing is set', () => {
    expect(may(OPEN, '2027-01-01T00:00:00Z', 900).ok).toBe(true);
  });

  it('closes the booth once the hours are up', () => {
    const limits = { ...OPEN, closesHours: 24 };
    expect(may(limits, '2026-09-26T13:29:00Z').ok).toBe(true);
    const shut = may(limits, '2026-09-26T14:00:00Z');
    expect(shut.ok).toBe(false);
    expect(shut.ok === false && shut.code).toBe('booth_closed');
    // Something a guest can read, not a rule name.
    expect(shut.ok === false && shut.message).toMatch(/has closed/);
  });

  it('stops a guest who has had their share', () => {
    const limits = { ...OPEN, maxPerGuest: 5 };
    expect(may(limits, START, 4).ok).toBe(true);
    const full = may(limits, START, 5);
    expect(full.ok).toBe(false);
    expect(full.ok === false && full.code).toBe('booth_quota');
    expect(full.ok === false && full.message).toMatch(/5 photos/);
  });

  it('says the booth is closed before it says the guest is done', () => {
    // Both would refuse; the one that is not the guest's fault wins.
    const both = may({ closesHours: 1, maxPerGuest: 1 }, '2026-09-27T00:00:00Z', 50);
    expect(both.ok === false && both.code).toBe('booth_closed');
  });
});
