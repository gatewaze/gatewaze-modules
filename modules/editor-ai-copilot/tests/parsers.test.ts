import { describe, expect, it } from 'vitest';
import { parseTxt } from '../api/parsers/txt-parser.js';
import { parseMarkdown } from '../api/parsers/markdown-parser.js';

describe('parseTxt', () => {
  it('passes UTF-8 text through', () => {
    const r = parseTxt(Buffer.from('Hello, world.\nEinmal mit Umlaut: Grün.', 'utf-8'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('Hello, world.\nEinmal mit Umlaut: Grün.');
  });

  it('strips control characters but preserves \\t \\n \\r', () => {
    // 0x00..0x08 NUL/SOH/etc, 0x0B VT, 0x0C FF, 0x0E..0x1F, 0x7F DEL
    const dirty = Buffer.from('a\x00b\x07c\x0Bd\x0Ee\x7Ff\ttab\nnewline\rcr', 'utf-8');
    const r = parseTxt(dirty);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('abcdef\ttab\nnewline\rcr');
  });

  it('handles empty buffer', () => {
    const r = parseTxt(Buffer.alloc(0));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('');
  });
});

describe('parseMarkdown', () => {
  it('preserves markdown syntax (headings, emphasis, lists)', () => {
    const md = '# Title\n\nSome *italic* and **bold** text.\n\n- one\n- two';
    const r = parseMarkdown(Buffer.from(md, 'utf-8'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('# Title');
      expect(r.text).toContain('*italic*');
      expect(r.text).toContain('- one');
    }
  });

  it('strips inline HTML tags (script smuggling vector)', () => {
    const md = '# Hi\n\nSome <script>alert(1)</script> and <strong>bold</strong> text.';
    const r = parseMarkdown(Buffer.from(md, 'utf-8'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).not.toContain('<script>');
      expect(r.text).not.toContain('<strong>');
      // raw text content (without tags) survives — only tags are stripped.
      expect(r.text).toContain('alert(1)');
      expect(r.text).toContain('bold');
    }
  });

  it('strips inline HTML even when nested in lists', () => {
    const md = '- item one\n- item <iframe src=evil></iframe> two';
    const r = parseMarkdown(Buffer.from(md, 'utf-8'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).not.toContain('<iframe');
  });
});
