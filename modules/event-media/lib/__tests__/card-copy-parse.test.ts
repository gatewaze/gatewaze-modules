import { describe, it, expect } from 'vitest';
import { parseCard } from '../booth-provider.js';

/**
 * The vision model returns the browse-card fields as JSON, and about 3%
 * of an album-wide run came back as JSON it could not itself parse.
 * Every observed failure was the same shape: a comma missing between
 * two entries of `words`. A photo that fails here has no title for the
 * rest of the night, so the parser tolerates it.
 */
describe('parseCard', () => {
  const good = JSON.stringify({
    title: 'Deep End',
    words: ['Poolside', 'Sun Kissed', 'Refreshing'],
    kind: 'Series',
    genre: 'romance',
    eyebrow: 'Season One',
  });

  it('reads well-formed JSON', () => {
    expect(parseCard(good)).toMatchObject({
      title: 'Deep End',
      words: ['Poolside', 'Sun Kissed', 'Refreshing'],
      genre: 'romance',
    });
  });

  // The exact malformation seen in production on 2026-09-21, four times
  // in one run of 145.
  it('recovers when a comma is missing between descriptors', () => {
    const broken =
      '{"title":"Deep End","words":["Poolside" "Sun Kissed" "Refreshing"],' +
      '"kind":"Series","genre":"romance","eyebrow":"Season One"}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(parseCard(broken)).toMatchObject({
      title: 'Deep End',
      words: ['Poolside', 'Sun Kissed', 'Refreshing'],
      kind: 'Series',
      genre: 'romance',
      eyebrow: 'Season One',
    });
  });

  it('recovers a trailing comma in the array', () => {
    const broken =
      '{"title":"Last Round","words":["After Hours","Pint","Cheers",],' +
      '"kind":"Films","genre":"comedy","eyebrow":""}';
    expect(parseCard(broken)).toMatchObject({
      title: 'Last Round',
      words: ['After Hours', 'Pint', 'Cheers'],
    });
  });

  // Recovery must not invent a card out of a reply that has no usable
  // content — the caller needs to see the failure and retry.
  it('gives up when the title is unrecoverable', () => {
    expect(parseCard('{"words":["A" "B" "C"]}')).toBeNull();
  });

  it('gives up when the words are unrecoverable', () => {
    expect(parseCard('{"title":"Deep End" "kind":"Series"}')).toBeNull();
  });
});
