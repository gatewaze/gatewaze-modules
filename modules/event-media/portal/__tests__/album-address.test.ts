// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { albumAddress, pageBaseFrom } from '../event-pages/_components/_lib/album-address';

describe('the page an album belongs to', () => {
  it('is the address itself when no album was named', () => {
    expect(pageBaseFrom('/photos', null)).toBe('/photos');
    expect(pageBaseFrom('/events/dan-sarah/photos')).toBe('/events/dan-sarah/photos');
  });

  it('is the address less the album, when one was', () => {
    expect(pageBaseFrom('/photos/photo-booth', 'photo-booth')).toBe('/photos');
    expect(pageBaseFrom('/events/x/photos/getting-ready', 'getting-ready')).toBe('/events/x/photos');
  });

  // The bug: the album was appended to an address that already named one,
  // and then again on the next load.
  it('never doubles the album, however many times it is asked', () => {
    let base = pageBaseFrom('/photos/photo-booth', 'photo-booth');
    let address = albumAddress(base, 'photo-booth');
    expect(address).toBe('/photos/photo-booth');
    for (let i = 0; i < 5; i++) {
      base = pageBaseFrom(address, 'photo-booth');
      address = albumAddress(base, 'photo-booth');
      expect(address).toBe('/photos/photo-booth');
    }
  });

  it('is not fooled by an album that merely looks like the end of the path', () => {
    // The page is /photos; the album is not 'photos'.
    expect(pageBaseFrom('/photos', 'photos')).toBe('/');
    // A trailing slash is not a segment.
    expect(pageBaseFrom('/photos/', null)).toBe('/photos');
  });
});

describe('the address of an album', () => {
  it('is the page, then the album', () => {
    expect(albumAddress('/photos', 'the-day')).toBe('/photos/the-day');
    expect(albumAddress('/events/x/photos', 'evening-reception')).toBe('/events/x/photos/evening-reception');
  });

  it('is the page itself for "everything"', () => {
    expect(albumAddress('/photos', null)).toBe('/photos');
    expect(albumAddress('/photos')).toBe('/photos');
  });

  it('does not care how many slashes it is given', () => {
    expect(albumAddress('/photos/', 'the-day')).toBe('/photos/the-day');
    expect(albumAddress('/', null)).toBe('/');
  });
});
