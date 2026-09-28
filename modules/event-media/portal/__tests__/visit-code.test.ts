// @ts-nocheck — vitest harness.

/**
 * /photos shows the albums unless the address itself carries an upload
 * code.
 *
 * Reported live on 2026-09-28: a guest who had once opened the page
 * with ?u=<code> was put straight back into the upload app every time
 * they opened /photos afterwards. The rule was right but it was latched
 * for the life of the mounted page, so it outlived the address that set
 * it -- and the event's own "Photos" tab is a client-side link, which
 * changes the address without remounting anything.
 *
 * These are the addresses a visitor actually opens, and which half of
 * the page each one asks for.
 */

import { describe, it, expect } from 'vitest';
import { uploadCodeOf } from '../event-pages/_components/_lib/visit-code.js';

/** What photos.tsx does with the answer: a code is the app, null is the albums. */
const showsGuestApp = (search: string | null | undefined) => uploadCodeOf(search) !== null;

describe('uploadCodeOf', () => {
  it('reads the code the QR short link hands over', () => {
    expect(uploadCodeOf('u=p8es4qi3ex')).toBe('p8es4qi3ex');
  });

  it('reads it with a leading question mark, as an address is written', () => {
    expect(uploadCodeOf('?u=p8es4qi3ex')).toBe('p8es4qi3ex');
  });

  it('reads it alongside the rest of a booth link', () => {
    expect(uploadCodeOf('?u=p8es4qi3ex&tab=booth&decade=1980s')).toBe('p8es4qi3ex');
  });

  it('has nothing to read on a bare address', () => {
    expect(uploadCodeOf('')).toBeNull();
    expect(uploadCodeOf(null)).toBeNull();
    expect(uploadCodeOf(undefined)).toBeNull();
  });

  it('refuses anything that is not a short code', () => {
    expect(uploadCodeOf('u=abc')).toBeNull();
    expect(uploadCodeOf('u=ABCDEF')).toBeNull();
    expect(uploadCodeOf('u=p8es4qi3ex-and-then-some-more')).toBeNull();
    expect(uploadCodeOf('u=../../etc')).toBeNull();
    expect(uploadCodeOf('u=')).toBeNull();
  });
});

describe('showsGuestApp', () => {
  it('opens the guest app for a visit that arrived with a code', () => {
    expect(showsGuestApp('?u=p8es4qi3ex')).toBe(true);
  });

  // The report itself: /photos with no code is the albums, whatever
  // this phone remembers of an earlier visit. The helper is given the
  // address and nothing else, so a stored code cannot reach it.
  it('shows the albums on a bare /photos, however often the phone has been here', () => {
    expect(showsGuestApp('')).toBe(false);
  });

  // The event's own "Photos" tab is a client-side link: it takes the
  // code off the address without remounting the page, which is how a
  // returning guest ended up in the app at an address that had none.
  it('shows the albums once a link has taken the code off the address', () => {
    expect(showsGuestApp('?u=p8es4qi3ex')).toBe(true);
    expect(showsGuestApp('')).toBe(false);
  });

  // The booth pushes history entries with no URL of their own, so the
  // address -- and the code on it -- is the same on every one of them.
  it('keeps a guest in the app through the booth\'s own history entries', () => {
    const address = '?u=p8es4qi3ex&tab=booth';
    expect(showsGuestApp(address)).toBe(true);
    expect(showsGuestApp(address)).toBe(true);
  });

  it('shows the albums for a shared album or photograph link', () => {
    expect(showsGuestApp('?album=the-day')).toBe(false);
    expect(showsGuestApp('?album=the-day&photo=2f6b0c9e')).toBe(false);
  });

  // The projector is opened from an address the organiser is given,
  // which carries the code as well. ?display=1 on its own is a visitor.
  it('shows the albums for ?display=1 with no code', () => {
    expect(showsGuestApp('?display=1')).toBe(false);
  });

  it('still opens the projector address', () => {
    expect(showsGuestApp('?u=p8es4qi3ex&display=1')).toBe(true);
  });
});
