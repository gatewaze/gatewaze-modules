// @ts-nocheck — vitest harness.

/**
 * The projector's settings live in the operator's browser, so an
 * upgrade must not quietly change what is on screen.
 *
 * Live fault, 2026-09-21: the first per-stream migration was handed the
 * saved object ALREADY merged over the defaults. The defaults always
 * supply a `day`, so "did this person save a day block?" was always
 * true, and every pre-split save silently lost its effect to the new
 * default. Caught on the live display, not by a test — hence this file.
 */

import { describe, it, expect } from 'vitest';
import {
  migrateStreams,
  normaliseStream,
  normaliseRotation,
  nextInRotation,
  DEFAULT_READY,
  DEFAULT_PRELOAD,
  DEFAULT_DAY,
  DEFAULT_BOOTH,
} from '../event-pages/_components/_lib/display-settings.js';

describe('migrateStreams', () => {
  it('folds a pre-split save onto the day', () => {
    const { day } = migrateStreams({
      mode: 'slideshow', effect: 'kenburns', intervalMs: 12000, stream: 'day',
    });
    expect(day.effect).toBe('kenburns');
    expect(day.intervalMs).toBe(12000);
  });

  // The regression itself: merging the defaults in first made this fail.
  it('does not let the defaults masquerade as a saved day block', () => {
    const merged = { ...{ day: DEFAULT_DAY, booth: DEFAULT_BOOTH }, effect: 'kenburns' };
    // Passing a pre-merged object is the mistake; passing the real save
    // is what the caller must do.
    expect(migrateStreams({ effect: 'kenburns' }).day.effect).toBe('kenburns');
    // And when a day block genuinely was saved, it wins over the flat field.
    expect(migrateStreams(merged).day.effect).toBe(DEFAULT_DAY.effect);
  });

  it('keeps a saved day block and fills gaps from the defaults', () => {
    const { day } = migrateStreams({ day: { effect: 'blur' } });
    expect(day.effect).toBe('blur');
    expect(day.intervalMs).toBe(DEFAULT_DAY.intervalMs);
    expect(day.camera).toBe(DEFAULT_DAY.camera);
  });

  it('gives the booth its own defaults rather than the day\'s flat ones', () => {
    const { booth } = migrateStreams({ effect: 'kenburns', intervalMs: 12000 });
    expect(booth).toEqual(DEFAULT_BOOTH);
    expect(booth.columns).toBe(3);
  });

  it('survives an empty or absent save', () => {
    expect(migrateStreams(null).day).toEqual(DEFAULT_DAY);
    expect(migrateStreams(undefined).booth).toEqual(DEFAULT_BOOTH);
    expect(migrateStreams({}).day).toEqual(DEFAULT_DAY);
  });

  it('ignores a day block that is not an object', () => {
    expect(migrateStreams({ day: 'kenburns' }).day).toEqual(DEFAULT_DAY);
    expect(migrateStreams({ day: null }).day).toEqual(DEFAULT_DAY);
  });
});

describe('normaliseStream', () => {
  it('accepts the four views and the rotation', () => {
    for (const v of ['preload', 'ready', 'day', 'booth', 'mix']) expect(normaliseStream(v)).toBe(v);
  });

  // Preload is the only view certain to have photos before the day, so
  // a fresh or garbled setting must not open on an empty screen.
  it('opens on Preload for anything else', () => {
    for (const v of [undefined, null, '', 'wall', 42, {}]) {
      expect(normaliseStream(v)).toBe('preload');
    }
  });
});

describe('Preload settings', () => {
  it('get their own defaults on a save that predates them', () => {
    const { preload, day } = migrateStreams({ day: { effect: 'wedflix' } });
    expect(preload).toEqual(DEFAULT_PRELOAD);
    expect(day.effect).toBe('wedflix');
  });

  it('keep what was saved for them', () => {
    expect(migrateStreams({ preload: { effect: 'kenburns' } }).preload.effect).toBe('kenburns');
  });

  // Selfies are never billed as programmes, so their default is not Wedflix.
  it('default to a treatment that is not Wedflix', () => {
    expect(DEFAULT_PRELOAD.effect).not.toBe('wedflix');
  });
});

describe('Getting ready', () => {
  it('has its own defaults, and keeps a saved block', () => {
    expect(migrateStreams({}).ready).toEqual(DEFAULT_READY);
    expect(migrateStreams({ ready: { effect: 'wedflix' } }).ready.effect).toBe('wedflix');
  });

  // Adding a view must not disturb a setup saved before it existed.
  it('leaves an older save\'s other views alone', () => {
    const m = migrateStreams({ day: { effect: 'blur' }, booth: { columns: 2 } });
    expect(m.day.effect).toBe('blur');
    expect(m.booth.columns).toBe(2);
  });
});

describe('normaliseRotation', () => {
  it('keeps known views once each, in panel order', () => {
    expect(normaliseRotation(['booth', 'ready', 'booth', 'nope'])).toEqual(['ready', 'booth']);
  });

  // "In turn" used to mean the day and the booth; a save from then, or a
  // rotation emptied to nothing, keeps meaning that.
  it('falls back to the day and the booth', () => {
    for (const v of [undefined, null, [], 'day', [42]]) expect(normaliseRotation(v)).toEqual(['day', 'booth']);
  });
});

describe('nextInRotation', () => {
  const all = () => true;

  it('walks the rotation in order and wraps', () => {
    const r = ['preload', 'ready', 'day'];
    expect(nextInRotation(r, 'preload', all)).toBe('ready');
    expect(nextInRotation(r, 'ready', all)).toBe('day');
    expect(nextInRotation(r, 'day', all)).toBe('preload');
  });

  // The morning of the wedding, the booth has nothing yet.
  it('skips a view with nothing to show', () => {
    const has = (v) => v !== 'booth';
    expect(nextInRotation(['ready', 'day', 'booth'], 'day', has)).toBe('ready');
  });

  it('stays put when no other view has photos', () => {
    expect(nextInRotation(['ready', 'day'], 'day', (v) => v === 'day')).toBe('day');
  });

  it('starts from the first when the current view left the rotation', () => {
    expect(nextInRotation(['ready', 'booth'], 'day', all)).toBe('ready');
    expect(nextInRotation(['ready', 'booth'], 'day', () => false)).toBe('ready');
  });

  it('holds a one-view rotation on that view', () => {
    expect(nextInRotation(['ready'], 'ready', all)).toBe('ready');
  });
});
