import { describe, it, expect } from 'vitest';
import { normalizeRichText } from '../rich-text.js';

describe('normalizeRichText — image alignment + width (v1)', () => {
  it('keeps a plain image constrained to the column (unchanged behaviour)', () => {
    const out = normalizeRichText('<img src="x.png" alt="x">');
    expect(out).toContain('max-width:100%');
    expect(out).toContain('height:auto');
    expect(out).not.toContain('text-align'); // no wrapper when unaligned
  });

  it('applies a % width from data-width', () => {
    const out = normalizeRichText('<img src="x.png" data-width="50">');
    expect(out).toContain('width:50%');
    expect(out).toContain('max-width:100%'); // still capped
  });

  it('wraps a centre-aligned image in a text-aligned block with inline-block img', () => {
    const out = normalizeRichText('<img src="x.png" data-align="center" data-width="75">');
    expect(out).toMatch(/<div style="text-align:center;[^"]*">\s*<img[^>]*><\/div>/);
    expect(out).toContain('display:inline-block');
    expect(out).toContain('width:75%');
  });

  it('supports left and right alignment', () => {
    expect(normalizeRichText('<img src="x" data-align="left">')).toContain('text-align:left');
    expect(normalizeRichText('<img src="x" data-align="right">')).toContain('text-align:right');
  });

  it('drops the editor-only inline style so display:block cannot override inline-block', () => {
    const out = normalizeRichText(
      '<img src="x" data-align="center" style="max-width:100%;height:auto;display:block;">',
    );
    expect(out).toContain('display:inline-block');
    expect(out).not.toContain('display:block'); // the editor style was stripped
  });

  it('ignores invalid align/width values (falls back to plain)', () => {
    const out = normalizeRichText('<img src="x" data-align="diagonal" data-width="abc">');
    expect(out).not.toContain('text-align'); // no wrapper
    expect(out).not.toMatch(/(?<!-)width:\d+%/); // no standalone width: (max-width:100% is fine)
    expect(out).toContain('max-width:100%'); // preserve branch still caps to the column
  });

  it('still normalises lists alongside images', () => {
    const out = normalizeRichText('<ul><li><p>a</p></li></ul><img src="x" data-align="center">');
    expect(out).toContain('padding-left:20px'); // list normalisation intact
    expect(out).toContain('text-align:center');
  });
});
