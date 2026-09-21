// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { resolveViews, tagView } from '../view-albums.js';

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
