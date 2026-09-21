// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { wedflixSchedule } from '../event-pages/_components/_lib/wedflix-timing.js';

describe('wedflixSchedule, on a slide long enough for the full sequence', () => {
  const s = wedflixSchedule(10000, true);

  it('brings the beats in one second apart, after the photograph', () => {
    expect(s.in.title).toBe(1000);
    expect(s.in.words).toBe(2000);
    expect(s.in.rank).toBe(3000);
  });

  it('takes them out in reverse order, half a second apart', () => {
    expect(s.out.rank).toBeLessThan(s.out.words);
    expect(s.out.words).toBeLessThan(s.out.title);
    expect(s.out.title - s.out.words).toBe(500);
    expect(s.out.words - s.out.rank).toBe(500);
  });

  it('leaves faster than it arrives', () => {
    expect(s.outFadeMs).toBeLessThan(s.inFadeMs);
  });

  // The next photograph should arrive to a clean frame.
  it('finishes the last fade exactly as the slide ends', () => {
    expect(s.out.title + s.outFadeMs).toBe(10000);
  });

  it('holds the complete card for at least a second', () => {
    const allIn = s.in.rank + s.inFadeMs;
    expect(s.out.rank - allIn).toBeGreaterThanOrEqual(1000);
  });
});

describe('a card without a Top 10 flag', () => {
  const s = wedflixSchedule(10000, false);
  it('has only the title and words', () => {
    expect(Object.keys(s.in).sort()).toEqual(['title', 'words']);
    expect(s.out.rank).toBeUndefined();
  });
});

describe('a slide too short for the full sequence', () => {
  for (const d of [4000, 5000, 6000]) {
    const s = wedflixSchedule(d, true);
    // Compressed, never overlapping: text must not flick on and straight
    // off again.
    it(`at ${d}ms, every beat is fully in before any beat starts out`, () => {
      const lastIn = Math.max(s.in.title, s.in.words, s.in.rank) + s.inFadeMs;
      const firstOut = Math.min(s.out.title, s.out.words, s.out.rank);
      expect(lastIn).toBeLessThanOrEqual(firstOut);
    });
    it(`at ${d}ms, still finishes as the slide ends`, () => {
      expect(s.out.title + s.outFadeMs).toBeCloseTo(d, 6);
    });
  }
});
