/**
 * Matching Takeout files to known videos (lib/takeout-match.ts).
 *
 * The cases that matter are the ones where a wrong match attaches somebody
 * else's recording to a talk: two videos with the same title, a CSV naming an
 * id we do not know, a filename Takeout has mangled.
 */

import { describe, it, expect } from 'vitest';
import { normaliseTitle, parseCsv, parseTakeoutCsv, matchFile, isVideoFile } from '../lib/takeout-match.js';

const known = [
  { id: 'v1', provider_video_id: 'aaaaaaaaaaa', title: 'Giving Your Agentic Coding AI a Security Brain' },
  { id: 'v2', provider_video_id: 'bbbbbbbbbbb', title: 'MCP: Challenges & Opportunities' },
  { id: 'v3', provider_video_id: 'ccccccccccc', title: 'Keynote' },
  { id: 'v4', provider_video_id: 'ddddddddddd', title: 'Keynote' },
];

describe('normaliseTitle', () => {
  it('drops punctuation, case, accents, the extension and a duplicate suffix', () => {
    expect(normaliseTitle('MCP: Challenges & Opportunities.mp4')).toBe('mcp challenges opportunities');
    expect(normaliseTitle('Café Talk (2).MOV')).toBe('cafe talk');
  });
});

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });
});

describe('parseTakeoutCsv', () => {
  const csv = [
    'Video ID,Approx Duration (ms),Video Title (Original),Privacy',
    'aaaaaaaaaaa,1380000,"Giving Your Agentic Coding AI a Security Brain",Public',
    'bad-id,10,Nope,Public',
  ].join('\n');

  it('reads id, title and duration in seconds', () => {
    expect(parseTakeoutCsv(csv)).toEqual([
      { videoId: 'aaaaaaaaaaa', title: 'Giving Your Agentic Coding AI a Security Brain', durationSeconds: 1380 },
    ]);
  });

  it('returns nothing for a CSV that is not a Takeout video list', () => {
    expect(parseTakeoutCsv('name,email\nx,y')).toEqual([]);
  });
});

describe('matchFile', () => {
  const csv = parseTakeoutCsv('Video ID,Video Title (Original)\naaaaaaaaaaa,Giving Your Agentic Coding AI a Security Brain\nzzzzzzzzzzz,Unknown Talk');

  it('matches through the CSV when the id is known', () => {
    expect(matchFile('Giving Your Agentic Coding AI a Security Brain.mp4', known, csv))
      .toEqual({ videoId: 'v1', youtubeId: 'aaaaaaaaaaa', by: 'csv' });
  });

  it('falls back to a unique title match, surviving Takeout filename mangling', () => {
    expect(matchFile('MCP_ Challenges & Opportunities.mp4', known, csv))
      .toEqual({ videoId: 'v2', youtubeId: 'bbbbbbbbbbb', by: 'title' });
  });

  it('refuses an ambiguous title rather than guessing', () => {
    expect(matchFile('Keynote.mp4', known, csv)).toBeNull();
  });

  it('does not match through a CSV id we do not know', () => {
    expect(matchFile('Unknown Talk.mp4', known, csv)).toBeNull();
  });

  it('is null for an empty name', () => {
    expect(matchFile('.mp4', known, csv)).toBeNull();
  });
});

describe('isVideoFile', () => {
  it('accepts the containers Takeout hands out and nothing else', () => {
    expect(isVideoFile('talk.MP4')).toBe(true);
    expect(isVideoFile('videos.csv')).toBe(false);
    expect(isVideoFile('talk.mp4.json')).toBe(false);
  });
});
