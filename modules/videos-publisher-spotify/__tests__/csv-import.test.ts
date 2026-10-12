/**
 * Spotify CSV import (lib/csv-import.ts).
 *
 * The column schema is documented nowhere, so the parser is tolerant about
 * headings and strict about what it will write. These tests pin the strict
 * half: the cases where guessing would put a number against the wrong thing.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCsvLine,
  parseDay,
  parseNumber,
  parseSpotifyCsv,
  playDefinitionFor,
  straddlesDefinitionChange,
} from '../lib/csv-import';

describe('parseCsvLine', () => {
  it('handles the things a real export contains', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseCsvLine('"Besen, Sandi",2')).toEqual(['Besen, Sandi', '2']);
    expect(parseCsvLine('"He said ""hi""",1')).toEqual(['He said "hi"', '1']);
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('parseNumber', () => {
  it('reads the formats a dashboard exports', () => {
    expect(parseNumber('1,234')).toBe(1234);
    expect(parseNumber('56%')).toBe(56);
    expect(parseNumber('0')).toBe(0);
  });

  it('returns undefined, NOT 0, for a blank', () => {
    // 0 plays and "no figure given" are different facts.
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber(undefined)).toBeUndefined();
    expect(parseNumber('n/a')).toBeUndefined();
  });
});

describe('parseDay', () => {
  it('normalises to YYYY-MM-DD', () => {
    expect(parseDay('2026-06-12')).toBe('2026-06-12');
    expect(parseDay('12 June 2026')).toBe('2026-06-12');
    expect(parseDay('06/12/2026')).toBe('2026-06-12');
  });

  it('does not shift the day in a timezone behind UTC', () => {
    // Date.parse of a bare date gives LOCAL midnight; toISOString() then
    // moves it back a day west of Greenwich, filing every figure in the
    // file against the wrong date.
    const saved = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(parseDay('12 June 2026')).toBe('2026-06-12');
      expect(parseDay('2026-06-12')).toBe('2026-06-12');
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });
  it('returns null rather than inventing a date', () => {
    expect(parseDay('')).toBeNull();
    expect(parseDay('recently')).toBeNull();
  });
});

describe('parseSpotifyCsv', () => {
  it('reads a per-episode-per-day export', () => {
    const r = parseSpotifyCsv(
      'Date,Episode,Plays,Listeners\n2026-07-01,Inside a Game,1200,900\n2026-07-02,Inside a Game,1300,950\n',
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ episodeKey: 'Inside a Game', day: '2026-07-01', plays: 1200, listeners: 900 });
  });

  it('matches headings by alias, because Spotify renames them', () => {
    const r = parseSpotifyCsv('Date,Episode Title,Starts,Spotify Audience\n2026-07-01,Ep,5,4\n');
    expect(r.rows[0]).toMatchObject({ plays: 5, listeners: 4 });
  });

  it('REFUSES the file when there is no episode column', () => {
    // Attributing a whole file to one arbitrary episode is worse than
    // importing nothing.
    const r = parseSpotifyCsv('Date,Plays\n2026-07-01,1200\n');
    expect(r.rows).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('reports headings it did not recognise, so they can be added', () => {
    const r = parseSpotifyCsv('Episode,Plays,Wobble Factor\nEp,5,9\n');
    expect(r.unknownHeadings).toContain('wobble factor');
  });

  it('skips a row with no readable figures rather than writing zeroes', () => {
    const r = parseSpotifyCsv('Date,Episode,Plays\n2026-07-01,Ep,\n');
    expect(r.rows).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('handles an empty or header-only file', () => {
    expect(parseSpotifyCsv('').rows).toEqual([]);
    expect(parseSpotifyCsv('Date,Episode,Plays').rows).toEqual([]);
  });
});

describe('the 11 June 2026 play-definition change', () => {
  it('labels each side of it', () => {
    // Before: any start counted. After: thirty seconds of listening.
    expect(playDefinitionFor('2026-06-10')).toBe('pre_2026_06_11');
    expect(playDefinitionFor('2026-06-11')).toBe('thirty_second');
    expect(playDefinitionFor('2026-10-01')).toBe('thirty_second');
  });

  it('flags an import that spans it', () => {
    // Averaging across the change produces a step nobody can explain later.
    expect(straddlesDefinitionChange([{ episodeKey: 'a', day: '2026-06-01' }, { episodeKey: 'a', day: '2026-07-01' }]))
      .toBe(true);
    expect(straddlesDefinitionChange([{ episodeKey: 'a', day: '2026-07-01' }, { episodeKey: 'a', day: '2026-08-01' }]))
      .toBe(false);
    expect(straddlesDefinitionChange([])).toBe(false);
  });

  it('records the definition on a parsed file', () => {
    expect(parseSpotifyCsv('Date,Episode,Plays\n2026-05-01,Ep,5\n').definition).toBe('pre_2026_06_11');
    expect(parseSpotifyCsv('Date,Episode,Plays\n2026-09-01,Ep,5\n').definition).toBe('thirty_second');
  });
});
