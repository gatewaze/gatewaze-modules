// @ts-nocheck — vitest harness.

/**
 * A photo reaches the projector only once its layers and browse copy
 * exist. Reported 2026-09-21: new uploads panned across the cinematic
 * view with no depth, because the row is created when the bytes land
 * and the rest is generated afterwards.
 *
 * The backstop matters as much as the gate. If a photo could be held
 * back indefinitely, one failed background job on the night would keep
 * a guest's photograph off the screen for good.
 */

import { describe, it, expect } from 'vitest';
import {
  isProcessed,
  isReady,
  partitionReady,
  pollAfter,
  feedChanged,
  PROCESSING_GRACE_MS,
} from '../event-pages/_components/_lib/photo-ready.js';

const NOW = Date.parse('2026-09-25T18:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const done = {
  variants: { plate: 'p.jpg', cutout: 'c.png', medium: 'm.jpg' },
  card: { title: 'Last Round', words: ['a', 'b', 'c'] },
  created_at: ago(1000),
};

describe('isProcessed', () => {
  it('wants both layers and the copy', () => {
    expect(isProcessed(done)).toBe(true);
  });

  it('is not satisfied by a partial result', () => {
    expect(isProcessed({ ...done, card: null })).toBe(false);
    expect(isProcessed({ ...done, variants: { cutout: 'c.png' } })).toBe(false);
    expect(isProcessed({ ...done, variants: { plate: 'p.jpg' } })).toBe(false);
    expect(isProcessed({ variants: null, card: null })).toBe(false);
  });
});

describe('isReady', () => {
  it('shows a finished photo straight away', () => {
    expect(isReady(done, NOW)).toBe(true);
  });

  it('holds back one that is still processing', () => {
    expect(isReady({ ...done, card: null, created_at: ago(5000) }, NOW)).toBe(false);
  });

  // The backstop: a failed job must not cost a guest their photograph.
  it('shows an unfinished photo once the grace has passed', () => {
    const stuck = { variants: {}, card: null, created_at: ago(PROCESSING_GRACE_MS + 1000) };
    expect(isReady(stuck, NOW)).toBe(true);
  });

  it('shows a photo whose timestamp cannot be read', () => {
    expect(isReady({ variants: {}, card: null, created_at: null }, NOW)).toBe(true);
    expect(isReady({ variants: {}, card: null, created_at: 'not a date' }, NOW)).toBe(true);
  });

  it('treats the grace boundary as still waiting', () => {
    const edge = { variants: {}, card: null, created_at: ago(PROCESSING_GRACE_MS) };
    expect(isReady(edge, NOW)).toBe(false);
  });
});

describe('partitionReady', () => {
  it('separates what can be shown from what is still coming', () => {
    const waiting = { variants: {}, card: null, created_at: ago(2000) };
    const { ready, pending } = partitionReady([done, waiting], NOW);
    expect(ready).toEqual([done]);
    expect(pending).toEqual([waiting]);
  });

  it('keeps every photo in one bucket or the other', () => {
    const list = [done, { variants: {}, card: null, created_at: ago(10) }];
    const { ready, pending } = partitionReady(list, NOW);
    expect(ready.length + pending.length).toBe(list.length);
  });
});

import { hasBrowseCard } from '../event-pages/_components/_lib/photo-ready.js';

describe('hasBrowseCard', () => {
  const card = { title: 'Last Round', words: ['a', 'b', 'c'] };

  it('accepts an upload of the day that has its card', () => {
    expect(hasBrowseCard({ album: 'day', card })).toBe(true);
    expect(hasBrowseCard({ album: 'booth', card })).toBe(true);
  });

  // An upload whose copy has not been generated would show as a bare
  // photo in the middle of a Wedflix run.
  it('rejects an upload with no card yet', () => {
    expect(hasBrowseCard({ album: 'day', card: null })).toBe(false);
    expect(hasBrowseCard({ album: 'day' })).toBe(false);
    expect(hasBrowseCard({ album: 'day', card: { title: '   ' } })).toBe(false);
    expect(hasBrowseCard({ album: 'day', card: { title: 42 } })).toBe(false);
  });

  // Seeds carry generated copy but are never billed as programmes.
  it('rejects a seed selfie even though it has copy', () => {
    expect(hasBrowseCard({ album: 'seed', card })).toBe(false);
    expect(hasBrowseCard({ card })).toBe(false);
  });
});

describe('pollAfter', () => {
  const NOW = Date.parse('2026-09-25T15:00:00Z');
  const ago = (ms) => new Date(NOW - ms).toISOString();
  const done = { variants: { plate: 'p', cutout: 'c' }, card: { title: 'x' } };

  it('asks from the newest photo when everything is finished', () => {
    expect(pollAfter([{ ...done, created_at: ago(5000) }], ago(1000), NOW)).toBe(ago(1000));
  });

  // The live fault: a booth poster seen half-made was never fetched again.
  it('reaches back to the oldest photo still processing', () => {
    const items = [
      { ...done, created_at: ago(1000) },
      { variants: {}, card: null, created_at: ago(60_000) },
      { variants: { plate: 'p' }, card: null, created_at: ago(30_000) },
    ];
    expect(pollAfter(items, ago(1000), NOW)).toBe(ago(60_000));
  });

  it('stops waiting on a photo past the grace window', () => {
    const items = [{ variants: {}, card: null, created_at: ago(PROCESSING_GRACE_MS + 1000) }];
    expect(pollAfter(items, ago(1000), NOW)).toBe(ago(1000));
  });

  it('copes with nothing held yet', () => {
    expect(pollAfter([], null, NOW)).toBeNull();
  });
});

describe('feedChanged', () => {
  const base = { variants: { thumb: 't' }, card: null, album: 'booth' };
  it('notices new layers, a new card and a new album', () => {
    expect(feedChanged(base, { ...base, variants: { thumb: 't', plate: 'p' } })).toBe(true);
    expect(feedChanged(base, { ...base, card: { title: 'x' } })).toBe(true);
    expect(feedChanged(base, { ...base, album: 'day' })).toBe(true);
  });
  it('is quiet when nothing moved', () => {
    expect(feedChanged(base, { ...base, variants: { thumb: 't' } })).toBe(false);
  });
});

import { pruneMissing } from '../event-pages/_components/_lib/photo-ready.js';

describe('pruneMissing', () => {
  const at = (id, t) => ({ id, created_at: `2026-09-25T${t}:00Z` });

  // A guest deleted their booth photo: it must leave the big screen.
  it('drops a photo the complete feed no longer lists', () => {
    const held = [at('a', '20:00'), at('gone', '19:00'), at('b', '18:00')];
    expect(pruneMissing(held, [at('a', '20:00'), at('b', '18:00')], true).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('keeps photos older than a partial page, which are only off the page', () => {
    const held = [at('a', '20:00'), at('gone', '19:00'), at('old', '10:00')];
    const kept = pruneMissing(held, [at('a', '20:00'), at('b', '18:00')], false).map((p) => p.id);
    expect(kept).toEqual(['a', 'old']);
  });

  it('leaves everything alone when a partial page is empty', () => {
    const held = [at('a', '20:00')];
    expect(pruneMissing(held, [], false)).toEqual(held);
  });
});
