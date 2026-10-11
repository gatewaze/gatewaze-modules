/**
 * The backfill's decisions (lib/backfill.ts, spec §6.5).
 *
 * Each group here pins something the spec argues for rather than something the
 * code happens to do:
 *
 *   - scope: a dead source is a normal outcome recorded once, not retried
 *   - order: oldest first, and total, so the cursor cannot stall
 *   - the review gate: §6.5 wants the run to stop and be looked at
 *   - the cursor: a value that will not parse must scan, not skip
 */

import { describe, it, expect } from 'vitest';
import {
  hasScheduleSource,
  isInScope,
  selectBatch,
  compareByStartThenId,
  shouldPauseForReview,
  cursorFilterValue,
  advanceCursor,
  itemStatus,
  counterFor,
  reviewCounts,
  type CandidateEvent,
  type ImportState,
} from '../lib/backfill.js';

const ev = (over: Partial<CandidateEvent> = {}): CandidateEvent => ({
  id: '00000000-0000-4000-8000-000000000001',
  event_start: '2023-05-01T09:00:00.000Z',
  eventScheduleUrl: 'https://kccnceu2023.sched.com',
  ...over,
});

const imp = (over: Partial<ImportState> = {}): ImportState => ({
  status: null,
  schedule_url: null,
  url_origin: null,
  last_success_at: null,
  ...over,
});

const OPEN = { retryUnavailable: false, forceReimport: false };

describe('hasScheduleSource', () => {
  it('uses a manual URL on the import row in preference to the event link', () => {
    const e = ev({ eventScheduleUrl: null });
    expect(hasScheduleSource(e, imp({ url_origin: 'manual', schedule_url: 'https://x.sched.com' }))).toBe(true);
  });

  it('falls back to the event\'s own action link', () => {
    expect(hasScheduleSource(ev(), undefined)).toBe(true);
  });

  it('is false when there is nothing to fetch', () => {
    expect(hasScheduleSource(ev({ eventScheduleUrl: null }), undefined)).toBe(false);
  });

  it('ignores a manual origin with no URL on it', () => {
    expect(hasScheduleSource(ev({ eventScheduleUrl: null }), imp({ url_origin: 'manual' }))).toBe(false);
  });
});

describe('isInScope', () => {
  it('includes an event that has never been imported', () => {
    expect(isInScope(ev(), undefined, OPEN)).toBe(true);
  });

  it('excludes an event that already imported successfully', () => {
    const state = imp({ last_success_at: '2026-01-01T00:00:00.000Z' });
    expect(isInScope(ev(), state, OPEN)).toBe(false);
    expect(isInScope(ev(), state, { ...OPEN, forceReimport: true })).toBe(true);
  });

  it('excludes a source already recorded as unavailable, per §6.5', () => {
    const state = imp({ status: 'unavailable' });
    expect(isInScope(ev(), state, OPEN)).toBe(false);
    expect(isInScope(ev(), state, { ...OPEN, retryUnavailable: true })).toBe(true);
  });

  it('excludes an event with no source even under force', () => {
    expect(isInScope(ev({ eventScheduleUrl: null }), undefined, {
      retryUnavailable: true, forceReimport: true,
    })).toBe(false);
  });

  it('includes a previously failed import, which is worth another attempt', () => {
    expect(isInScope(ev(), imp({ status: 'failed' }), OPEN)).toBe(true);
  });
});

describe('ordering', () => {
  const a = ev({ id: '00000000-0000-4000-8000-00000000000a', event_start: '2023-01-01T00:00:00.000Z' });
  const b = ev({ id: '00000000-0000-4000-8000-00000000000b', event_start: '2024-01-01T00:00:00.000Z' });

  it('is oldest first', () => {
    expect([b, a].sort(compareByStartThenId).map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('breaks a tie on id so the order is total', () => {
    const t1 = ev({ id: '00000000-0000-4000-8000-00000000000b', event_start: '2023-01-01T00:00:00.000Z' });
    const t2 = ev({ id: '00000000-0000-4000-8000-00000000000a', event_start: '2023-01-01T00:00:00.000Z' });
    expect([t1, t2].sort(compareByStartThenId).map((e) => e.id)).toEqual([t2.id, t1.id]);
  });

  it('sorts an event with no start date last, so it cannot block the cursor', () => {
    const undated = ev({ id: '00000000-0000-4000-8000-00000000000c', event_start: null });
    expect([undated, b, a].sort(compareByStartThenId).map((e) => e.id))
      .toEqual([a.id, b.id, undated.id]);
  });
});

describe('selectBatch', () => {
  const mk = (n: number): CandidateEvent[] =>
    Array.from({ length: n }, (_, i) =>
      ev({
        id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
        event_start: `20${20 + i}-01-01T00:00:00.000Z`,
      }));

  it('caps at the batch size and returns the oldest', () => {
    const batch = selectBatch(mk(10), new Map(), new Set(), { ...OPEN, batchSize: 3 });
    expect(batch).toHaveLength(3);
    expect(batch[0].event_start).toBe('2020-01-01T00:00:00.000Z');
  });

  it('skips events this run already attempted, which is what makes a re-run idempotent', () => {
    const all = mk(5);
    const done = new Set([all[0].id, all[1].id]);
    const batch = selectBatch(all, new Map(), done, { ...OPEN, batchSize: 10 });
    expect(batch.map((e) => e.id)).toEqual(all.slice(2).map((e) => e.id));
  });

  it('skips an out-of-scope event without consuming batch capacity', () => {
    const all = mk(4);
    const states = new Map([[all[0].id, imp({ last_success_at: '2026-01-01T00:00:00.000Z' })]]);
    const batch = selectBatch(all, states, new Set(), { ...OPEN, batchSize: 2 });
    expect(batch.map((e) => e.id)).toEqual([all[1].id, all[2].id]);
  });

  it('rejects a row whose id is not a uuid', () => {
    const batch = selectBatch([ev({ id: 'not-a-uuid' })], new Map(), new Set(), { ...OPEN, batchSize: 5 });
    expect(batch).toHaveLength(0);
  });
});

describe('shouldPauseForReview', () => {
  it('fires when the count crosses a multiple of review_every', () => {
    expect(shouldPauseForReview(0, 5, 5)).toBe(true);
    expect(shouldPauseForReview(5, 10, 5)).toBe(true);
  });

  it('keeps firing through a long run, not only at the start', () => {
    expect(shouldPauseForReview(95, 100, 5)).toBe(true);
  });

  it('does not fire mid-interval', () => {
    expect(shouldPauseForReview(0, 3, 5)).toBe(false);
    expect(shouldPauseForReview(6, 9, 5)).toBe(false);
  });

  it('fires when a batch jumps past a boundary rather than landing on it', () => {
    expect(shouldPauseForReview(3, 8, 5)).toBe(true);
  });

  it('is disabled by 0, which is how a run goes unattended', () => {
    expect(shouldPauseForReview(0, 50, 0)).toBe(false);
  });

  it('never fires when nothing was processed', () => {
    expect(shouldPauseForReview(5, 5, 5)).toBe(false);
  });

  it('ignores a nonsense review_every rather than pausing forever', () => {
    expect(shouldPauseForReview(0, 5, Number.NaN)).toBe(false);
    expect(shouldPauseForReview(0, 5, -3)).toBe(false);
  });
});

describe('cursorFilterValue', () => {
  it('re-serialises a valid timestamp rather than passing it through', () => {
    expect(cursorFilterValue({ cursor_event_start: '2023-05-01T09:00:00Z' }))
      .toBe('2023-05-01T09:00:00.000Z');
  });

  it('returns null for a value that will not parse, so the caller scans from the start', () => {
    expect(cursorFilterValue({ cursor_event_start: 'tomorrow' })).toBeNull();
    expect(cursorFilterValue({ cursor_event_start: "2023-01-01' or '1'='1" })).toBeNull();
  });

  it('returns null when there is no cursor yet', () => {
    expect(cursorFilterValue({ cursor_event_start: null })).toBeNull();
  });
});

describe('advanceCursor', () => {
  it('moves to the last event in the batch', () => {
    const batch = [ev({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }), ev({
      id: 'bbbbbbbb-0000-4000-8000-000000000002', event_start: '2024-06-01T00:00:00.000Z',
    })];
    expect(advanceCursor({ cursor_event_start: null, cursor_event_uuid: null }, batch)).toEqual({
      cursor_event_start: '2024-06-01T00:00:00.000Z',
      cursor_event_uuid: 'bbbbbbbb-0000-4000-8000-000000000002',
    });
  });

  it('leaves the cursor alone on an empty batch', () => {
    const run = { cursor_event_start: '2023-01-01T00:00:00.000Z', cursor_event_uuid: 'x' };
    expect(advanceCursor(run, [])).toEqual(run);
  });
});

describe('item status and counters', () => {
  it('passes the importer\'s own statuses through', () => {
    for (const s of ['complete', 'unavailable', 'failed', 'skipped']) {
      expect(itemStatus(s)).toBe(s);
    }
  });

  it('maps anything unrecognised to errored, so the check constraint holds', () => {
    expect(itemStatus(undefined)).toBe('errored');
    expect(itemStatus('exploded')).toBe('errored');
  });

  it('counts an errored item as a failure', () => {
    expect(counterFor('errored')).toBe('failed_count');
    expect(counterFor('failed')).toBe('failed_count');
  });

  it('counts nothing for a skipped item', () => {
    expect(counterFor('skipped')).toBeNull();
  });
});

describe('reviewCounts', () => {
  it('reads the speaker numbers §6.5 asks an operator to watch', () => {
    expect(reviewCounts({ speakers: 107, speakers_matched_people: 12, unmatched_speakers: 95, sessions: 92 }))
      .toEqual({ speakers: 107, speakers_matched_people: 12, unmatched_speakers: 95, sessions: 92 });
  });

  it('is null for a missing, negative or non-integer value', () => {
    expect(reviewCounts({ speakers: -1, speakers_matched_people: 1.5, unmatched_speakers: 'lots' }))
      .toEqual({ speakers: null, speakers_matched_people: null, unmatched_speakers: null, sessions: null });
  });

  it('tolerates no stats blob at all', () => {
    expect(reviewCounts(null).speakers).toBeNull();
    expect(reviewCounts(undefined).sessions).toBeNull();
  });
});
