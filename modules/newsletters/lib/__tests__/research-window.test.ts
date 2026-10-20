import { describe, it, expect } from 'vitest';
import { computeResearchWindow, dateAtHour, tzOffsetMinutes } from '../research-window.js';

const now = new Date('2026-10-17T21:00:00Z'); // Saturday 21:00 UTC research for a Monday 09:00 send

describe('computeResearchWindow', () => {
  it('anchors to the previous edition research run and excludes its keys (no gap, no repeat)', () => {
    const w = computeResearchWindow({ now, previous: { id: 'p', edition_date: '2026-10-12', send_target_at: '2026-10-12T16:00:00Z', research_started_at: '2026-10-10T21:00:00Z', research_keys: ['k1', 'k2'] }, cadenceDays: 7, timezone: 'America/Los_Angeles', cadenceHour: 9 });
    expect(w.anchor).toBe('previous_research');
    expect(w.from).toBe('2026-10-10T21:00:00.000Z');
    expect(w.to).toBe(now.toISOString());
    expect(w.excludeKeys).toEqual(['k1', 'k2']);
  });
  it('falls back to the previous send, then the edition date at the cadence hour in the collection timezone', () => {
    const w1 = computeResearchWindow({ now, previous: { id: 'p', edition_date: '2026-10-12', send_target_at: '2026-10-12T16:00:00Z', research_started_at: null, research_keys: [] }, cadenceDays: 7, timezone: 'UTC', cadenceHour: 9 });
    expect(w1.anchor).toBe('previous_send');
    expect(w1.from).toBe('2026-10-12T16:00:00.000Z');
    const w2 = computeResearchWindow({ now, previous: { id: 'p', edition_date: '2026-10-12', send_target_at: null, research_started_at: null, research_keys: [] }, cadenceDays: 7, timezone: 'America/Los_Angeles', cadenceHour: 9 });
    expect(w2.anchor).toBe('previous_date');
    expect(w2.from).toBe('2026-10-12T16:00:00.000Z'); // 09:00 PDT = 16:00 UTC
  });
  it('caps a stalled newsletter at 21 days and uses cadence then the 8-day default otherwise', () => {
    const w = computeResearchWindow({ now, previous: { id: 'p', edition_date: '2026-06-01', send_target_at: '2026-06-01T16:00:00Z', research_started_at: '2026-05-30T21:00:00Z', research_keys: [] }, cadenceDays: 7, timezone: 'UTC', cadenceHour: 9 });
    expect(new Date(w.from).getTime()).toBe(now.getTime() - 21 * 86_400_000);
    expect(computeResearchWindow({ now, previous: null, cadenceDays: 7, timezone: null, cadenceHour: null })).toMatchObject({ anchor: 'cadence' });
    const d = computeResearchWindow({ now, previous: null, cadenceDays: null, timezone: null, cadenceHour: null });
    expect(d.anchor).toBe('default');
    expect(new Date(d.from).getTime()).toBe(now.getTime() - 8 * 86_400_000);
    expect(computeResearchWindow({ now, previous: null, cadenceDays: null, timezone: null, cadenceHour: null, fixedDays: 14 })).toMatchObject({ anchor: 'fixed' });
  });
});

describe('dateAtHour / tzOffsetMinutes across DST', () => {
  it('keeps the local hour when the offset changes', () => {
    // US DST ends 2026-11-01: 09:00 Los Angeles is 16:00Z before and 17:00Z after.
    expect(dateAtHour('2026-10-26', 9, 'America/Los_Angeles').toISOString()).toBe('2026-10-26T16:00:00.000Z');
    expect(dateAtHour('2026-11-02', 9, 'America/Los_Angeles').toISOString()).toBe('2026-11-02T17:00:00.000Z');
    expect(tzOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'Europe/London')).toBe(60);
    expect(tzOffsetMinutes(new Date('2026-01-01T12:00:00Z'), 'Europe/London')).toBe(0);
    expect(tzOffsetMinutes(new Date(), 'Not/AZone')).toBe(0);
  });
});
