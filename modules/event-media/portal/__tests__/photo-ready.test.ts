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
