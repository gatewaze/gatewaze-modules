// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { BOOTH_ERAS, eraLooksResolve, erasFor, isEraSetting } from '../booth-eras.js';
import { BOOTH_EFFECTS, buildPrompt } from '../booth-effects.js';

describe('booth eras', () => {
  it('gives every era exactly six looks, none repeated anywhere', () => {
    const all = BOOTH_ERAS.flatMap((e) => e.looks);
    for (const era of BOOTH_ERAS) expect(era.looks).toHaveLength(6);
    expect(new Set(all).size).toBe(all.length);
  });

  it('names only looks that exist as styles', () => {
    expect(eraLooksResolve()).toEqual([]);
  });

  // The guard rails are the feature (see booth-effects.ts): every new look
  // goes out wrapped in them.
  it('sends every era look through the people-count and identity rules', () => {
    for (const id of BOOTH_ERAS.flatMap((e) => e.looks)) {
      const prompt = buildPrompt(BOOTH_EFFECTS.find((e) => e.id === id));
      expect(prompt).toMatch(/^CRITICAL RULE: reproduce exactly the same number of people/);
      expect(prompt).toMatch(/Keep the same people with their exact same faces/);
      expect(prompt).toMatch(/Do not add any titles, taglines, personal names/);
      expect(prompt).toMatch(/Reminder: do not add, invent or duplicate any person/);
    }
  });

  it('offers all eras, or just the one an event is themed on', () => {
    expect(erasFor('all')).toHaveLength(BOOTH_ERAS.length);
    expect(erasFor(null)).toHaveLength(BOOTH_ERAS.length);
    expect(erasFor('1980s').map((e) => e.key)).toEqual(['1980s']);
    // A setting naming an era that no longer exists falls back to all.
    expect(erasFor('1920s')).toHaveLength(BOOTH_ERAS.length);
  });

  it('accepts only real settings', () => {
    expect(isEraSetting('all')).toBe(true);
    expect(isEraSetting('1970s')).toBe(true);
    for (const v of ['1920s', '', null, 1980, 'ALL']) expect(isEraSetting(v)).toBe(false);
  });
});
