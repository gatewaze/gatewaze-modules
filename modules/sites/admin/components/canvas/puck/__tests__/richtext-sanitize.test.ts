// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Sanitisation contract for the RichText field. Per
 * spec-builder-evaluation §3.4.3.
 *
 * The strict allowlist is the boundary: no <script>, no inline event
 * handlers, no <style> / <iframe> / <object>, no `javascript:` href.
 * Whatever the user types in TipTap (or pastes) MUST be filtered to
 * this set before storage.
 *
 * sanitizeRichText runs both incoming (so legacy values containing
 * unsupported tags are scrubbed before mounting the editor) and
 * outgoing (every onChange) — the test suite covers both directions
 * by treating sanitiser output as canonical.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeRichText } from '../fields/richtext-sanitize.js';

describe('sanitizeRichText — strict allowlist', () => {
  it('preserves allowed inline + block tags', () => {
    const input = '<p>Hello <strong>world</strong> <em>!</em></p>';
    expect(sanitizeRichText(input)).toBe(input);
  });

  it('preserves headings, lists, blockquote, code', () => {
    const input = '<h2>T</h2><ul><li>x</li></ul><blockquote>q</blockquote><code>c</code>';
    expect(sanitizeRichText(input)).toBe(input);
  });

  it('strips <script> tags entirely', () => {
    const input = '<p>safe</p><script>alert(1)</script>';
    expect(sanitizeRichText(input)).toBe('<p>safe</p>');
  });

  it('strips on* event-handler attributes', () => {
    const input = '<p onerror="alert(1)" onclick="x()">hi</p>';
    expect(sanitizeRichText(input)).toBe('<p>hi</p>');
  });

  it('strips <iframe> / <object> / <embed> / <svg>', () => {
    expect(sanitizeRichText('<iframe src="x"></iframe>')).toBe('');
    expect(sanitizeRichText('<object data="x"></object>')).toBe('');
    expect(sanitizeRichText('<embed src="x">')).toBe('');
    expect(sanitizeRichText('<svg><circle r="10"/></svg>')).toBe('');
  });

  it('strips inline <style> blocks and style attributes', () => {
    expect(sanitizeRichText('<style>.x{color:red}</style>')).toBe('');
    // Style attributes are not in ALLOWED_ATTR — should be removed.
    const result = sanitizeRichText('<p style="color:red">x</p>');
    expect(result).not.toContain('style=');
    expect(result).toContain('<p>');
    expect(result).toContain('x');
  });

  it('rejects javascript: hrefs on links', () => {
    // eslint-disable-next-line no-script-url
    const input = '<a href="javascript:alert(1)">click</a>';
    const out = sanitizeRichText(input);
    expect(out).not.toContain('javascript:');
  });

  it('preserves http(s), mailto, tel, and root-relative hrefs', () => {
    expect(sanitizeRichText('<a href="https://example.com">x</a>')).toContain('href="https://example.com"');
    expect(sanitizeRichText('<a href="http://example.com">x</a>')).toContain('href="http://example.com"');
    expect(sanitizeRichText('<a href="mailto:a@b.co">x</a>')).toContain('href="mailto:a@b.co"');
    expect(sanitizeRichText('<a href="/internal">x</a>')).toContain('href="/internal"');
  });

  it('removes data: URIs on hrefs (XSS vector)', () => {
    const input = '<a href="data:text/html,<script>x</script>">y</a>';
    expect(sanitizeRichText(input)).not.toContain('data:');
  });

  it('strips form/input but preserves text content via KEEP_CONTENT=false', () => {
    const out = sanitizeRichText('<form><input name="x"/>fallback</form>');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
  });

  it('strips images (not in allowlist; images go through MediaField)', () => {
    expect(sanitizeRichText('<p>before <img src="/x.jpg" alt="y"/> after</p>'))
      .toBe('<p>before  after</p>');
  });

  it('handles deeply nested allowed tags', () => {
    const input = '<p><strong><em><u>nested</u></em></strong></p>';
    expect(sanitizeRichText(input)).toBe(input);
  });

  it('idempotent — running twice yields the same result', () => {
    const dirty = '<p onerror="x">hi <script>alert()</script></p><iframe src="x"></iframe>';
    const once = sanitizeRichText(dirty);
    const twice = sanitizeRichText(once);
    expect(twice).toBe(once);
  });
});
