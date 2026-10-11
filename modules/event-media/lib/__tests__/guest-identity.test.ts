// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { displayName, foldName, matchGuests } from '../guest-identity.js';

const LIST = [
  { id: '1', name: 'Dan Baker' },
  { id: '2', name: 'David Jones' },
  { id: '3', name: 'Sarah Baker' },
  { id: '4', name: 'Zoë O\'Neill' },
  { id: '5', name: 'Mary-Ann Adams' },
  { id: '6', name: 'Aidan Smith' },
];
const names = (q) => matchGuests(LIST, q).map((g) => g.name);

describe('matchGuests', () => {
  // The example asked for: "da" finds Dan and David.
  it('finds names whose first name starts with what was typed', () => {
    expect(names('da')).toEqual(['Dan Baker', 'David Jones']);
  });

  it('matches the start of any word, first names ranked first', () => {
    expect(names('bak')).toEqual(['Dan Baker', 'Sarah Baker']);
    expect(names('ann')).toEqual(['Mary-Ann Adams']);
  });

  // "Aidan" contains "da" but does not start any word with it.
  it('does not match the middle of a word', () => {
    expect(names('da')).not.toContain('Aidan Smith');
  });

  it('takes a first name and an initial', () => {
    expect(names('dan b')).toEqual(['Dan Baker']);
  });

  it('ignores case, accents and extra spaces', () => {
    expect(names('  ZOE ')).toEqual(["Zoë O'Neill"]);
  });

  it('needs at least two letters, so the list cannot be read out a letter at a time', () => {
    expect(names('d')).toEqual([]);
    expect(names('')).toEqual([]);
    expect(names(null)).toEqual([]);
    expect(names({ q: 'da' })).toEqual([]);
  });

  it('returns a handful at most', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `Dan ${i}` }));
    expect(matchGuests(many, 'dan')).toHaveLength(8);
  });
});

describe('names', () => {
  it('builds a display name from the invitation', () => {
    expect(displayName(' Dan ', 'Baker')).toBe('Dan Baker');
    expect(displayName('Dan', null)).toBe('Dan');
    expect(displayName('', '')).toBeNull();
  });

  it('folds for comparison', () => {
    expect(foldName('  Zoë   O\'Neill ')).toBe("zoe o'neill");
  });
});
