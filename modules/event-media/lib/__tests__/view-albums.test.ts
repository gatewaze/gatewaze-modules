// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { albumForUpload, resolveViews, tagView } from '../view-albums.js';

const ALBUMS = [
  { album_id: 'A-seed', view: 'seed' },
  { album_id: 'A-day', view: 'day' },
  { album_id: 'A-booth', view: 'booth' },
  { album_id: 'A-ready', view: 'ready' },
];

const resolve = (items, tags) => resolveViews(ALBUMS, items, new Map(Object.entries(tags)));

describe('resolveViews', () => {
  it('follows album membership', () => {
    const r = resolve([{ album_id: 'A-day', media_id: 'p1' }], { p1: 'seed' });
    expect(r.get('p1')).toBe('day');
  });

  it('falls back to the tag for a photo in no view album', () => {
    const r = resolve([], { p1: 'booth', p2: 'seed' });
    expect(r.get('p1')).toBe('booth');
    expect(r.get('p2')).toBe('seed');
  });

  // Added to a second album without being removed from the first: the
  // organiser meant to move it.
  it('prefers a view the photo was added to over its tag', () => {
    const r = resolve(
      [{ album_id: 'A-seed', media_id: 'p1' }, { album_id: 'A-day', media_id: 'p1' }],
      { p1: 'seed' },
    );
    expect(r.get('p1')).toBe('day');
  });

  it('keeps the tag when that is the only membership', () => {
    const r = resolve([{ album_id: 'A-booth', media_id: 'p1' }], { p1: 'booth' });
    expect(r.get('p1')).toBe('booth');
  });

  it('ranks the booth, then the day, above Preload among added views', () => {
    const r = resolve(
      [
        { album_id: 'A-seed', media_id: 'p1' },
        { album_id: 'A-booth', media_id: 'p1' },
        { album_id: 'A-day', media_id: 'p1' },
        { album_id: 'A-seed', media_id: 'p2' },
        { album_id: 'A-day', media_id: 'p2' },
      ],
      { p1: 'day', p2: 'booth' },
    );
    expect(r.get('p1')).toBe('booth');
    expect(r.get('p2')).toBe('day');
  });

  it('knows Getting ready, and ranks it above Preload only', () => {
    const r = resolve(
      [
        { album_id: 'A-ready', media_id: 'p1' },
        { album_id: 'A-ready', media_id: 'p2' }, { album_id: 'A-day', media_id: 'p2' },
      ],
      { p1: 'seed', p2: 'seed' },
    );
    expect(r.get('p1')).toBe('ready');
    expect(r.get('p2')).toBe('day');
    expect(tagView({ album: 'ready' })).toBe('ready');
  });

  it('ignores ordinary albums', () => {
    const r = resolve([{ album_id: 'Holiday', media_id: 'p1' }], { p1: 'day' });
    expect(r.get('p1')).toBe('day');
  });

  it('ignores a mapping row with an unknown view', () => {
    const r = resolveViews(
      [{ album_id: 'X', view: 'mix' }],
      [{ album_id: 'X', media_id: 'p1' }],
      new Map([['p1', 'seed']]),
    );
    expect(r.get('p1')).toBe('seed');
  });
});

describe('tagView', () => {
  it('reads untagged and unknown tags as Preload', () => {
    expect(tagView({})).toBe('seed');
    expect(tagView(null)).toBe('seed');
    expect(tagView({ album: 'mix' })).toBe('seed');
    expect(tagView({ album: 'day' })).toBe('day');
  });
});

describe('albumForUpload', () => {
  const START = '2026-09-25T13:30:00Z';
  const at = (iso) => Date.parse(iso);
  it('is Getting ready before the start and The day from it', () => {
    expect(albumForUpload({ booth: false, eventStart: START, now: at('2026-09-25T09:00:00Z') })).toBe('ready');
    expect(albumForUpload({ booth: false, eventStart: START, now: at(START) })).toBe('day');
    // Half past six is where the day hands over to the evening.
    expect(albumForUpload({ booth: false, eventStart: START, now: at('2026-09-25T20:00:00Z') })).toBe('evening');
  });
  it('puts the booth in the booth whatever the time', () => {
    expect(albumForUpload({ booth: true, eventStart: START, now: at('2026-09-25T09:00:00Z') })).toBe('booth');
  });
  it('treats a missing or garbled start as no before', () => {
    for (const s of [null, undefined, '', 'soon']) {
      expect(albumForUpload({ booth: false, eventStart: s, now: 0 })).toBe('day');
    }
  });
});

import { boothAlbum } from '../view-albums.js';

describe('the night before, and the booth away from the event', () => {
  const START = '2026-09-25T13:30:00Z';
  const at = (iso: string) => Date.parse(iso);
  const upload = (takenAt: string | null, now = at('2026-09-27T10:00:00Z')) =>
    albumForUpload({ booth: false, eventStart: START, now, takenAt });

  it('files a photograph by when it was taken, whenever it is uploaded', () => {
    // All of these are uploaded two days late, from a camera roll.
    expect(upload('2026-09-25T19:40:00Z')).toBe('evening');    // at the party
    expect(upload('2026-09-25T09:14:00Z')).toBe('ready');      // that morning
    expect(upload('2026-09-24T20:30:00Z')).toBe('night');      // the evening before
    expect(upload('2026-09-24T09:00:00Z')).toBe('night');      // the day before
  });

  it('leaves anything older with the day, to be moved by hand', () => {
    expect(upload('2026-09-01T12:00:00Z')).toBe('day');
    expect(upload(null)).toBe('day');
  });

  it('keeps a booth picture made at the event, and separates one made at home', () => {
    const booth = (now: string) => boothAlbum({ eventStart: START, now: at(now) });
    expect(booth('2026-09-25T14:00:00Z')).toBe('booth');   // during
    expect(booth('2026-09-25T23:30:00Z')).toBe('booth');   // late on
    expect(booth('2026-09-25T06:00:00Z')).toBe('booth');   // getting ready
    expect(booth('2026-09-27T10:00:00Z')).toBe('elsewhere'); // two days later, at home
    expect(booth('2026-09-20T10:00:00Z')).toBe('elsewhere'); // a week early
  });

  it('keeps every booth picture when the event has no start time', () => {
    expect(boothAlbum({ eventStart: null, now: Date.now() })).toBe('booth');
    expect(albumForUpload({ booth: true, eventStart: null, now: Date.now() })).toBe('booth');
  });
});

describe('the evening reception', () => {
  const START = '2026-09-25T13:30:00Z';
  const upload = (takenAt: string) => albumForUpload({ booth: false, eventStart: START, now: Date.parse('2026-09-27T10:00:00Z'), takenAt });

  it('hands over at half past six', () => {
    expect(upload('2026-09-25T18:29:59')).toBe('day');
    expect(upload('2026-09-25T18:30:00')).toBe('evening');
    expect(upload('2026-09-25T23:59:00')).toBe('evening');
    // Into the small hours is still the party.
    expect(upload('2026-09-26T02:00:00')).toBe('evening');
  });

  it('stops being the evening the next morning', () => {
    // Fourteen hours after the start, the same ceiling a booth picture
    // gets: a photograph the following evening is not this party.
    expect(upload('2026-09-26T04:00:00')).toBe('day');
    expect(upload('2026-09-26T19:00:00')).toBe('day');
  });

  it('leaves the morning and the night before where they were', () => {
    expect(upload('2026-09-25T09:14:00')).toBe('ready');
    expect(upload('2026-09-24T20:30:00')).toBe('night');
  });

  // An evening do has no separate evening: it is all one party.
  it('has no evening for an event that starts after it', () => {
    const late = (takenAt: string) => albumForUpload({
      booth: false, eventStart: '2026-09-25T19:00:00Z', now: Date.parse('2026-09-26T10:00:00Z'), takenAt,
    });
    expect(late('2026-09-25T19:30:00')).toBe('evening');
    // ...and nothing lands before the start, as ever.
    expect(late('2026-09-25T18:45:00')).toBe('ready');
  });

  it('is what a photograph in two albums resolves to, over the day', () => {
    const albums = [{ album_id: 'a1', view: 'day' }, { album_id: 'a2', view: 'evening' }];
    const items = [{ album_id: 'a2', media_id: 'm1' }];
    const views = resolveViews(albums, items, new Map([['m1', 'day' as const]]));
    expect(views.get('m1')).toBe('evening');
  });
});

describe('an event that starts its evening at a different time', () => {
  const START = '2026-09-25T13:30:00Z';
  const upload = (takenAt: string, eveningFromMinutes?: number | null) => albumForUpload({
    booth: false, eventStart: START, now: Date.parse('2026-09-27T10:00:00Z'), takenAt, eveningFromMinutes,
  });

  it('keeps half past six when nothing is set', () => {
    expect(upload('2026-09-25T17:30:00')).toBe('day');
    expect(upload('2026-09-25T18:30:00')).toBe('evening');
  });

  it('moves the line where the organiser puts it', () => {
    // A reception that starts at five.
    expect(upload('2026-09-25T17:30:00', 17 * 60)).toBe('evening');
    expect(upload('2026-09-25T16:59:00', 17 * 60)).toBe('day');
    // ...or at eight.
    expect(upload('2026-09-25T19:30:00', 20 * 60)).toBe('day');
    expect(upload('2026-09-25T20:30:00', 20 * 60)).toBe('evening');
  });

  it('ignores a time that is not one', () => {
    for (const bad of [-1, 1440, NaN, null, undefined]) {
      expect(upload('2026-09-25T18:30:00', bad as number)).toBe('evening');
      expect(upload('2026-09-25T17:30:00', bad as number)).toBe('day');
    }
  });

  it('never puts the evening before the event starts', () => {
    // A reception "starting" at nine in the morning is the whole day.
    expect(albumForUpload({
      booth: false, eventStart: START, now: 0, takenAt: '2026-09-25T09:00:00', eveningFromMinutes: 9 * 60,
    })).toBe('ready');
    expect(albumForUpload({
      booth: false, eventStart: START, now: 0, takenAt: '2026-09-25T14:00:00', eveningFromMinutes: 9 * 60,
    })).toBe('evening');
  });
});
