import { describe, expect, it } from 'vitest';
import { truncateToBytes, TRUNCATION_MARKER_TEXT } from '../lib/web-tools/truncate.js';

describe('truncateToBytes', () => {
  it('returns input unchanged when within byte limit', () => {
    const r = truncateToBytes('hello', 100);
    expect(r).toBe('hello');
    expect(r.includes(TRUNCATION_MARKER_TEXT)).toBe(false);
  });

  it('appends the truncation marker when over the limit', () => {
    const long = 'a'.repeat(2000);
    const r = truncateToBytes(long, 100);
    expect(r.endsWith(TRUNCATION_MARKER_TEXT)).toBe(true);
    expect(r.length).toBeGreaterThan(100); // marker bytes pushed past the cut
  });

  it('never splits a multi-byte UTF-8 character', () => {
    // Each emoji is 4 UTF-8 bytes. Cut at 7 bytes — must walk back to 4.
    const text = '😀😀😀😀';
    const r = truncateToBytes(text, 7);
    // The truncated portion before the marker should be exactly one emoji
    // (4 bytes), not 7 bytes which would split the second emoji.
    const body = r.replace(TRUNCATION_MARKER_TEXT, '');
    expect(body).toBe('😀');
  });

  it('handles a mix of ASCII and multi-byte characters at the boundary', () => {
    // "ab" (2 bytes) + emoji (4 bytes). Cap at 4 bytes — should keep "ab".
    const r = truncateToBytes('ab😀cd', 4);
    expect(r.replace(TRUNCATION_MARKER_TEXT, '')).toBe('ab');
  });

  it('cap=0 returns just the marker', () => {
    const r = truncateToBytes('hello', 0);
    expect(r).toBe(TRUNCATION_MARKER_TEXT);
  });
});
