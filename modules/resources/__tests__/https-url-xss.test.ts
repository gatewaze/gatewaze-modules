import { describe, it, expect } from 'vitest';
import { validateBlock } from '../blocks';
import { renderTalkCardHtml } from '../portal/render-blocks';

/**
 * Regression for the stored XSS found on 2026-10-10.
 *
 * `nameLink` in the talk-card renderer interpolated a speaker's URL straight
 * into href="..." with no escaping, and the https-url validator only checked
 * that the value PARSED. `new URL()` accepts a literal double quote in a path
 * (it percent-encodes one in .href, but the stored string keeps it), so a
 * crafted speaker link broke out of the attribute.
 *
 * Both halves are pinned here: the value cannot be stored, and if one ever is,
 * the renderer still escapes it.
 */

const talkBlock = (linkedin: string) => ({
  kind: 'talk',
  slug: 'a-talk',
  sort_order: 0,
  data: { title: 'A Talk', speaker: { name: 'Angie Jones', linkedin } },
});

const formatRejected = (value: string): boolean =>
  validateBlock(talkBlock(value) as never, 'test')
    .some((i) => i.keyword === 'format');

describe('https-url validation refuses attribute-breakout characters', () => {
  it('accepts an ordinary profile URL', () => {
    expect(formatRejected('https://www.linkedin.com/in/angiejones')).toBe(false);
    expect(formatRejected('https://example.com/a/b?c=d&e=f')).toBe(false);
  });

  it('rejects a double quote, which new URL() happily parses', () => {
    expect(formatRejected('https://x/" onmouseover="alert(1)')).toBe(true);
  });

  it('rejects a single quote, which new URL() does not even encode', () => {
    expect(formatRejected("https://x/' onmouseover='alert(1)")).toBe(true);
  });

  it('rejects angle brackets, backticks, whitespace and backslashes', () => {
    expect(formatRejected('https://x/<script>')).toBe(true);
    expect(formatRejected('https://x/`cmd`')).toBe(true);
    expect(formatRejected('https://x/a b')).toBe(true);
    expect(formatRejected('https://x/a\\b')).toBe(true);
  });

  it('still rejects the schemes it always did', () => {
    expect(formatRejected('javascript:alert(1)')).toBe(true);
    expect(formatRejected('data:text/html,<script>alert(1)</script>')).toBe(true);
    expect(formatRejected('http://evil.com/x')).toBe(true);
  });
});

describe('the talk renderer escapes a speaker href regardless', () => {
  const render = (linkedin: string): string =>
    renderTalkCardHtml(
      { id: 'b1', ...talkBlock(linkedin) } as never,
      0,
      { pagePath: '/resources/x' } as never,
    );

  it('never emits a raw quote that would end the href attribute', () => {
    const html = render('https://x/" onmouseover="alert(1)');
    expect(html).not.toMatch(/href="https:\/\/x\/" onmouseover/);
    expect(html).toContain('&quot;');
  });

  it('escapes a single quote too', () => {
    const html = render("https://x/' onmouseover='alert(1)");
    expect(html).not.toMatch(/href="[^"]*' onmouseover='/);
  });

  it('leaves an ordinary URL usable', () => {
    const html = render('https://www.linkedin.com/in/angiejones');
    expect(html).toContain('href="https://www.linkedin.com/in/angiejones"');
  });
});
