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

  // The point: a 50s Halloween and a 70s Christmas, one per decade.
  it('names one look per occasion per decade, and knows them again', () => {
    expect(occasionLooks('all', '1950s')).toEqual(['halloween-1950s', 'christmas-1950s']);
    expect(occasionLooks('halloween', '1970s')).toEqual(['halloween-1970s']);
    expect(occasionLooks('none', '1970s')).toEqual([]);
    expect(eraOccasionLooks('1980s')).toEqual(['halloween-1980s', 'christmas-1980s']);
    expect(occasionLookId('christmas', '1970s')).toBe('christmas-1970s');
    expect(occasionOf('christmas-1970s')).toEqual({ occasion: 'christmas', era: '1970s' });
    for (const id of ['uk-decade-1970s', 'top-gun', 'easter-1970s', 'christmas-70s', 'christmas-', '']) {
      expect(occasionOf(id)).toBeNull();
    }
  });

  it('has a look in the catalogue for every occasion in every era, labelled with both', () => {
    for (const era of BOOTH_ERAS) {
      for (const o of BOOTH_OCCASIONS) {
        const e = boothEffect(occasionLookId(o.key, era.key));
        expect(e, `${o.key} ${era.key}`).not.toBeNull();
        expect(e.kind).toBe('style');
        expect(e.label).toMatch(new RegExp(`^(\\d0s|\\d{4}s) ${o.label}$`));
        expect(e.style).toMatch(new RegExp(o.label, 'i'));
        expect(e.style).toMatch(new RegExp(era.key.slice(0, 4)));
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
  it('sends every occasion look out wrapped in the guard rails, faces bare, no figures', () => {
    for (const era of BOOTH_ERAS) {
      for (const o of BOOTH_OCCASIONS) {
        const e = boothEffect(occasionLookId(o.key, era.key));
        const prompt = buildPrompt(e);
        expect(prompt).toMatch(/^CRITICAL RULE: reproduce exactly the same number of people/);
        expect(prompt).toMatch(/Keep the same people with their exact same faces/);
        expect(prompt).toMatch(/Do not add any titles, taglines, personal names/);
        expect(prompt).toMatch(/Reminder: do not add, invent or duplicate any person/);
        expect(prompt).toMatch(/Keep the original framing, crop and camera distance/);
        expect(prompt).toMatch(/no skeletons, mannequins, dummies, scarecrows, Father Christmas/);
        if (o.key === 'halloween') expect(prompt).toMatch(/no masks, no face paint/);
        // Wardrobes are lists, never one garment per person.
        expect(e.style).not.toMatch(/one (of them|person) (wears|in)/i);
      }
    }
  });
});
