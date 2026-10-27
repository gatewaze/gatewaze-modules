// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import {
  BOOTH_OCCASIONS, eraOccasionLooks, isOccasionSetting, occasionLookId, occasionLooks, occasionOf, occasionsFor,
} from '../booth-occasions.js';
import { BOOTH_ERAS, eraAllLooks, eraLooks, lookDecade } from '../booth-eras.js';
import { boothEffect, buildPrompt } from '../booth-effects.js';
import { placeRail } from '../booth-places.js';

describe('booth occasions', () => {
  it('offers none, one, or every occasion', () => {
    expect(occasionsFor('none')).toEqual([]);
    expect(occasionsFor(null)).toEqual([]);
    expect(occasionsFor(undefined)).toEqual([]);
    expect(occasionsFor('all').map((o) => o.key)).toEqual(['halloween', 'christmas']);
    expect(occasionsFor('christmas').map((o) => o.key)).toEqual(['christmas']);
    // A setting naming an occasion that does not exist means none.
    expect(occasionsFor('easter')).toEqual([]);
    expect(occasionsFor('drop table')).toEqual([]);
  });

  it('accepts only real settings', () => {
    for (const v of ['none', 'all', 'halloween', 'christmas']) expect(isOccasionSetting(v)).toBe(true);
    for (const v of ['easter', '', null, undefined, 7, 'ALL', 'Halloween']) expect(isOccasionSetting(v)).toBe(false);
  });

  // The point: a 50s Halloween and a 70s Christmas, each a family of
  // looks per decade -- the party, then the costumes.
  it('names each family member per decade, and knows them again', () => {
    expect(occasionLooks('all', '1950s')).toEqual([
      'halloween-1950s', 'halloween-costume-1950s', 'christmas-1950s', 'christmas-santa-1950s', 'christmas-elf-1950s',
    ]);
    expect(occasionLooks('halloween', '1970s')).toEqual(['halloween-1970s', 'halloween-costume-1970s']);
    expect(occasionLooks('none', '1970s')).toEqual([]);
    expect(eraOccasionLooks('1980s')).toHaveLength(5);
    expect(occasionLookId('christmas-elf', '1970s')).toBe('christmas-elf-1970s');
    expect(occasionOf('christmas-1970s')).toEqual({ occasion: 'christmas', era: '1970s' });
    expect(occasionOf('christmas-santa-1970s')).toEqual({ occasion: 'christmas', era: '1970s' });
    expect(occasionOf('halloween-costume-2020s')).toEqual({ occasion: 'halloween', era: '2020s' });
    for (const id of ['uk-decade-1970s', 'top-gun', 'easter-1970s', 'christmas-70s', 'christmas-', '', 'christmas-santa', 'santa-1970s']) {
      expect(occasionOf(id)).toBeNull();
    }
  });

  it('has a look in the catalogue for every family member in every era, labelled with the decade', () => {
    for (const era of BOOTH_ERAS) {
      for (const o of BOOTH_OCCASIONS) {
        for (const prefix of o.looks) {
          const e = boothEffect(occasionLookId(prefix, era.key));
          expect(e, `${prefix} ${era.key}`).not.toBeNull();
          expect(e.kind).toBe('style');
          expect(e.label).toMatch(/^(\d0s|\d{4}s) /);
          expect(e.style).toMatch(new RegExp(o.label, 'i'));
          expect(e.style).toMatch(new RegExp(era.key.slice(0, 4)));
        }
      }
    }
    expect(boothEffect('christmas-santa-1970s').label).toBe('70s Santa');
    expect(boothEffect('halloween-costume-1950s').label).toBe('50s Halloween costume');
  });

  // The costumes are the one place something goes on a face, and they
  // say how: paint that follows the real features, no beard, no mask.
  it('keeps the costume faces recognisable', () => {
    for (const era of BOOTH_ERAS) {
      const paint = buildPrompt(boothEffect(`halloween-costume-${era.key}`));
      expect(paint).toMatch(/painted directly onto their own faces and follows their own features/);
      expect(paint).toMatch(/No masks, no prosthetics/);
      const santa = buildPrompt(boothEffect(`christmas-santa-${era.key}`));
      expect(santa).toMatch(/No false beard/);
      expect(santa).toMatch(/red with white fur trim/);
      // The suit is a man's in the training data; the person must not be changed to fit it.
      expect(santa).toMatch(/a woman is a woman in a Father Christmas suit, never redrawn as a man/);
      const elf = buildPrompt(boothEffect(`christmas-elf-${era.key}`));
      expect(elf).toMatch(/pointed elf ears/);
      expect(elf).toMatch(/no prosthetic noses/);
      // A costume comes with a hat, so these must not carry the no-hats rule.
      for (const p of [paint, santa, elf]) {
        expect(p).toMatch(/Keep the original framing, crop and camera distance/);
        expect(p).not.toMatch(/No hats or sunglasses that were not in the input/);
        // Patches and badges on a costume invite invented words.
        expect(p).toMatch(/No words, slogans, lettering, logos, badges or patches/);
      }
    }
  });

  // An occasion look sits on the decade's board, in both places, but
  // belongs to neither place's own six.
  it('joins every era through eraAllLooks without entering either board', () => {
    for (const era of BOOTH_ERAS) {
      for (const id of eraOccasionLooks(era.key)) {
        expect(eraAllLooks(era)).toContain(id);
        expect(eraLooks(era, 'uk')).not.toContain(id);
        expect(eraLooks(era, 'us')).not.toContain(id);
      }
    }
  });

  // The country rail follows the decade in the id, so a 50s Halloween
  // in America is an American fifties.
  it('belongs to the decade in its id, for the place rail', () => {
    expect(lookDecade('halloween-1950s')).toBe('1950s');
    expect(lookDecade('christmas-2020s')).toBe('2020s');
    expect(lookDecade('uk-fifties-seaside')).toBe('1950s');
    expect(lookDecade('us-tens-brunch')).toBe('2010s');
    expect(lookDecade('halloween-1920s')).toBeNull();
    expect(lookDecade('no-such-look')).toBeNull();
    expect(placeRail(lookDecade('halloween-1950s'), 'us')).toMatch(/1950s America/);
    expect(placeRail(lookDecade('halloween-1950s'), 'uk')).toMatch(/1950s Britain/);
  });

  // The guard rails are the feature (booth-effects.ts), and these two
  // looks have their own: a Halloween that covers faces loses likeness,
  // and a figure in the scene is an invented person.
  it('sends every occasion look out wrapped in the guard rails, no figures', () => {
    for (const era of BOOTH_ERAS) {
      for (const id of eraOccasionLooks(era.key)) {
        const e = boothEffect(id);
        const prompt = buildPrompt(e);
        expect(prompt).toMatch(/^CRITICAL RULE: reproduce exactly the same number of people/);
        expect(prompt).toMatch(/Keep the same people with their exact same faces/);
        expect(prompt).toMatch(/Do not add any titles, taglines, personal names/);
        expect(prompt).toMatch(/Reminder: do not add, invent or duplicate any person/);
        expect(prompt).toMatch(/Keep the original framing, crop and camera distance/);
        expect(prompt).toMatch(/no skeletons, mannequins, dummies, scarecrows, Father Christmas/);
        // The party looks keep faces bare; only the costume says otherwise.
        if (id.startsWith('halloween-') && !id.includes('costume')) expect(prompt).toMatch(/no masks, no face paint/);
        // Wardrobes are lists, never one garment per person.
        expect(e.style).not.toMatch(/one (of them|person) (wears|in)/i);
      }
    }
  });
});
