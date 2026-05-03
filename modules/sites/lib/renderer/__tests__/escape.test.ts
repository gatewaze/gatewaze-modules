import { describe, expect, it } from 'vitest';
import { escapeHtml, escapeAttr } from '../escape.js';

describe('escapeHtml()', () => {
  it('escapes the standard 7 HTML metacharacters', () => {
    expect(escapeHtml('<script>"&\'`=</script>')).toBe(
      '&lt;script&gt;&quot;&amp;&#39;&#x60;&#x3D;&lt;/script&gt;',
    );
  });

  it('handles null and undefined as empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('coerces non-strings via String()', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(true)).toBe('true');
  });

  it('passes through non-metacharacters', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('escapeAttr()', () => {
  it('matches escapeHtml for double-quoted attribute usage', () => {
    expect(escapeAttr('a "b" & <c>')).toBe('a &quot;b&quot; &amp; &lt;c&gt;');
  });
});
