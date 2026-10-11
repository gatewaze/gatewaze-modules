/**
 * Who gets a speaker kit (lib/promo/eligibility.ts).
 *
 * The first test is the incident this gate was written for, kept as a test so
 * it cannot come back: a past conference whose `events` row was mis-dated a
 * year into the future, with 92 imported talks and no speaker avatars.
 */

import { describe, it, expect } from 'vitest';
import {
  kitIneligibleReason,
  partitionEligible,
  describeSkipped,
  DEFAULT_HORIZON_DAYS,
  type EligibilityInput,
} from '../lib/promo/eligibility.js';

const NOW = new Date('2026-10-11T00:00:00.000Z');

const talk = (over: Partial<EligibilityInput> = {}): EligibilityInput => ({
  talkId: 'aaaaaaaa-0000-4000-8000-000000000001',
  eventStart: '2026-11-01T09:00:00.000Z',
  eventEnd: '2026-11-02T17:00:00.000Z',
  avatarUrl: 'https://avatars.sched.co/c/9d/19223528/avatar.jpg',
  ...over,
});

describe('the AGNTCon incident', () => {
  // The real row: AGNTCon + MCPCon Europe ran in 2026 but was stored as
  // 2027-09-15, so `event_start >= now()` read it as upcoming.
  const misdated = (over: Partial<EligibilityInput> = {}) => talk({
    eventStart: '2027-09-15T00:00:00.000Z',
    eventEnd: '2027-09-16T00:00:00.000Z',
    avatarUrl: null,
    ...over,
  });

  it('refuses it, and the reason is the missing avatar, not the date', () => {
    // Worth being precise about: 2027-09-15 is about 339 days after
    // 2026-10-11, so it sits INSIDE the 365-day horizon. The horizon does not
    // save us here; the avatar rule does.
    expect(kitIneligibleReason(misdated(), { now: NOW })).toBe('no_avatar');
  });

  it('is not caught by the date rules at all, which is why the avatar rule exists', () => {
    // Give the same mis-dated event an avatar and it becomes eligible. That
    // is the honest limit of this gate: a wrong date cannot be detected.
    expect(kitIneligibleReason(misdated({ avatarUrl: 'https://avatars.sched.co/x.jpg' }), { now: NOW }))
      .toBeNull();
  });

  it('would have skipped all 92 talks, which is the point', () => {
    const batch = Array.from({ length: 92 }, (_, i) => misdated({ talkId: `t${i}` }));
    const { eligible, skipped } = partitionEligible(batch, { now: NOW });
    expect(eligible).toHaveLength(0);
    expect(skipped.no_avatar).toBe(92);
    expect(skipped.event_too_far_out).toBe(0);
  });
});

describe('the past-event rule', () => {
  it('allows an event that is still to come', () => {
    expect(kitIneligibleReason(talk(), { now: NOW })).toBeNull();
  });

  it('refuses an event that has finished', () => {
    expect(kitIneligibleReason(talk({
      eventStart: '2026-09-17T00:00:00.000Z', eventEnd: '2026-09-18T00:00:00.000Z',
    }), { now: NOW })).toBe('event_finished');
  });

  it('still allows an event that is mid-flight, which the old check denied', () => {
    // Started yesterday, ends tomorrow. `event_start >= now()` dropped this.
    expect(kitIneligibleReason(talk({
      eventStart: '2026-10-10T09:00:00.000Z', eventEnd: '2026-10-12T17:00:00.000Z',
    }), { now: NOW })).toBeNull();
  });

  it('falls back to the start date when there is no end date', () => {
    expect(kitIneligibleReason(talk({ eventStart: '2026-09-17T00:00:00.000Z', eventEnd: null }), { now: NOW }))
      .toBe('event_finished');
    expect(kitIneligibleReason(talk({ eventStart: '2026-11-01T00:00:00.000Z', eventEnd: null }), { now: NOW }))
      .toBeNull();
  });

  it('fails closed when there is no usable date at all', () => {
    expect(kitIneligibleReason(talk({ eventStart: null, eventEnd: null }), { now: NOW })).toBe('no_event_date');
    expect(kitIneligibleReason(talk({ eventStart: 'soon', eventEnd: 'later' }), { now: NOW })).toBe('no_event_date');
  });
});

describe('the horizon', () => {
  it('allows an event just inside it', () => {
    const inside = new Date(NOW.getTime() + (DEFAULT_HORIZON_DAYS - 1) * 86_400_000).toISOString();
    expect(kitIneligibleReason(talk({ eventStart: inside, eventEnd: inside }), { now: NOW })).toBeNull();
  });

  it('refuses an event just outside it', () => {
    const outside = new Date(NOW.getTime() + (DEFAULT_HORIZON_DAYS + 1) * 86_400_000).toISOString();
    expect(kitIneligibleReason(talk({ eventStart: outside, eventEnd: outside }), { now: NOW }))
      .toBe('event_too_far_out');
  });

  it('can be disabled with 0, for an operator who wants the old behaviour', () => {
    const farOut = '2029-01-01T00:00:00.000Z';
    expect(kitIneligibleReason(talk({ eventStart: farOut, eventEnd: farOut }), { now: NOW, horizonDays: 0 }))
      .toBeNull();
  });

  it('ignores a nonsense horizon rather than refusing everything', () => {
    expect(kitIneligibleReason(talk(), { now: NOW, horizonDays: Number.NaN })).toBeNull();
  });
});

describe('the avatar rule', () => {
  it('treats whitespace as no avatar', () => {
    expect(kitIneligibleReason(talk({ avatarUrl: '   ' }), { now: NOW })).toBe('no_avatar');
    expect(kitIneligibleReason(talk({ avatarUrl: '' }), { now: NOW })).toBe('no_avatar');
  });

  it('checks the date before the avatar, so the log names the real blocker', () => {
    // A finished event with no avatar fails on the date, because uploading a
    // photo would not make it eligible.
    expect(kitIneligibleReason(talk({
      eventStart: '2026-01-01T00:00:00.000Z', eventEnd: '2026-01-02T00:00:00.000Z', avatarUrl: null,
    }), { now: NOW })).toBe('event_finished');
  });
});

describe('describeSkipped', () => {
  it('lists only the reasons that fired', () => {
    const { skipped } = partitionEligible([
      talk({ talkId: 'a', avatarUrl: null }),
      talk({ talkId: 'b', eventStart: '2026-01-01T00:00:00.000Z', eventEnd: '2026-01-02T00:00:00.000Z' }),
    ], { now: NOW });
    const text = describeSkipped(skipped);
    expect(text).toContain('1 no_avatar');
    expect(text).toContain('1 event_finished');
    expect(text).not.toContain('no_event_date');
  });

  it('says "none" when nothing was skipped', () => {
    const { skipped } = partitionEligible([talk()], { now: NOW });
    expect(describeSkipped(skipped)).toBe('none');
  });
});
