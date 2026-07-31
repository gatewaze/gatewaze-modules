/**
 * MarkdownView — safe opt-in Markdown renderer.
 *
 * Fits the module's vitest config verbatim (`environment: 'node'`,
 * `include: ['__tests__/**\/*.test.ts']`, `globals: false`): no jsdom, no
 * testing-library, no JSX. We render to a static HTML string via
 * `renderToStaticMarkup(React.createElement(...))` and assert on the markup.
 *
 * Coverage:
 *   - Markdown actually renders (bold → <strong>, heading → <h*>).
 *   - Soft line breaks are preserved (not collapsed) so line-oriented prose
 *     keeps its shape.
 *   - Embedded raw HTML is escaped, not parsed (no rehype-raw → no injection).
 *   - `javascript:` link protocol is neutralised by react-markdown's default
 *     URL transform.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import MarkdownView from '../../admin/components/MarkdownView';

function render(md: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownView, { children: md }));
}

describe('MarkdownView', () => {
  it('renders Markdown formatting to HTML', () => {
    const html = render('# Title\n\nSome **bold** text');
    expect(html).toContain('<h1');
    expect(html).toContain('Title');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders GitHub-flavoured Markdown (tables) via remark-gfm', () => {
    const html = render('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table');
    expect(html).toContain('<td');
  });

  it('preserves soft line breaks rather than collapsing them', () => {
    // Two lines in one paragraph (single newline = soft break). react-markdown
    // emits the break as a literal "\n" text node; the pre-wrap wrapper then
    // preserves it visually. The newline must survive into the markup.
    const html = render('line one\nline two');
    expect(html).toContain('line one\nline two');
  });

  it('escapes embedded raw HTML instead of parsing it (no injection)', () => {
    const html = render('Hello <script>alert(1)</script> world');
    // The script tag must be escaped, never emitted as a live element.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises javascript: link protocols', () => {
    const html = render('[click me](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
    // The link text still renders.
    expect(html).toContain('click me');
  });
});
