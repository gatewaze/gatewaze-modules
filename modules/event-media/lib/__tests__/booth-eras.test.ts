// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { BOOTH_ERAS, eraAllLooks, eraLooks, eraLooksResolve, erasFor, isEraSetting } from '../booth-eras.js';
import { BOOTH_EFFECTS, buildPrompt, buildSamplePrompt } from '../booth-effects.js';

describe('booth eras', () => {
  it('gives every era six looks in each place, none repeated anywhere', () => {
    const all = BOOTH_ERAS.flatMap((e) => eraAllLooks(e));
    for (const era of BOOTH_ERAS) {
      expect(eraLooks(era, 'uk')).toHaveLength(6);
      expect(eraLooks(era, 'us')).toHaveLength(6);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  // The point of the two boards: a decade is not the same thing in
  // Britain as in America (asked 2026-09-23).
  it('makes the two boards genuinely different', () => {
    for (const era of BOOTH_ERAS) {
      const uk = eraLooks(era, 'uk');
      const us = eraLooks(era, 'us');
      expect(uk.filter((id) => us.includes(id))).toEqual([]);
    }
    // Anything but 'us' is the British board.
    expect(eraLooks(BOOTH_ERAS[0], null)).toEqual(BOOTH_ERAS[0].looks.uk);
    expect(eraLooks(BOOTH_ERAS[0], 'france')).toEqual(BOOTH_ERAS[0].looks.uk);
  });

  it('names only looks that exist as styles', () => {
    expect(eraLooksResolve()).toEqual([]);
  });

  // The guard rails are the feature (see booth-effects.ts): every new look
  // goes out wrapped in them.
  it('sends every era look through the people-count and identity rules', () => {
    for (const id of BOOTH_ERAS.flatMap((e) => eraAllLooks(e))) {
      const prompt = buildPrompt(BOOTH_EFFECTS.find((e) => e.id === id));
      expect(prompt).toMatch(/^CRITICAL RULE: reproduce exactly the same number of people/);
      expect(prompt).toMatch(/Keep the same people with their exact same faces/);
      expect(prompt).toMatch(/Do not add any titles, taglines, personal names/);
      expect(prompt).toMatch(/Reminder: do not add, invent or duplicate any person/);
      expect(prompt).toMatch(/The scene must be physically possible/);
      expect(prompt).toMatch(/heads the correct size for their bodies/);
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

describe('caricatures', () => {
  it('keep the physics rule but may exaggerate proportions', () => {
    const p = buildPrompt({ id: 'x', label: 'x', blurb: '', kind: 'style', style: 'a caricature', caricature: true });
    expect(p).toMatch(/physically possible/);
    expect(p).not.toMatch(/heads the correct size/);
  });

  // The old wording asked for large faces, which the model met with large heads.
  it('never asks for faces as large as the input', () => {
    for (const e of BOOTH_EFFECTS.filter((x) => x.style)) {
      expect(buildPrompt(e)).not.toMatch(/as large in the frame as|as large and as clear in the frame as in the input/);
    }
  });
});

describe('example pictures of the key people', () => {
  const look = BOOTH_EFFECTS.find((e) => e.id === 'top-gun');
  it('counts and names the people from their reference photos', () => {
    const p = buildSamplePrompt(look, [{ name: 'Dan', photos: 3 }, { name: 'Sarah', photos: 2 }]);
    expect(p).toMatch(/images 1 to 3 show Dan; images 4 to 5 show Sarah/);
    expect(p).toMatch(/exactly 2 people/);
    expect(p).toMatch(/physically possible/);
    expect(p).toMatch(/heads the correct size/);
    expect(p).toMatch(/Do not add any titles/);
  });
  it('handles one person and one photo', () => {
    const p = buildSamplePrompt(look, [{ name: 'Sam', photos: 1 }]);
    expect(p).toMatch(/image 1 shows Sam/);
    expect(p).toMatch(/exactly one person/);
  });
});
