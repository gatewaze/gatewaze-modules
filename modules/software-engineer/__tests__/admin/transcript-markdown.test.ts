/**
 * TranscriptMarkdown — safe Markdown renderer for the runs-stream transcript
 * (issue #10). Fits the module's vitest config (`environment: 'node'`,
 * `include: ['__tests__/**\/*.test.ts']`, `globals: false`): no jsdom, no
 * testing-library, no JSX. We render to a static HTML string via
 * `renderToStaticMarkup(React.createElement(...))` and assert on the markup.
 *
 * Coverage:
 *   - Markdown actually renders (bold → <strong>, heading → <h*>, tables via gfm).
 *   - Soft line breaks are preserved, not collapsed.
 *   - Embedded raw HTML is escaped, not parsed (no rehype-raw → no injection).
 *   - `javascript:` link protocol is neutralised (repo security rule).
 *   - The streaming normaliser closes an open fence / balances dangling markers,
 *     and only the streaming path applies it (completed messages render verbatim).
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import TranscriptMarkdown, { normalizeStreamingMarkdown } from '../../admin/components/TranscriptMarkdown';

function render(md: string, streaming = false): string {
  return renderToStaticMarkup(
    React.createElement(TranscriptMarkdown, { children: md, streaming }),
  );
}

describe('TranscriptMarkdown', () => {
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
    const html = render('line one\nline two');
    expect(html).toContain('line one\nline two');
  });

  it('escapes embedded raw HTML instead of parsing it (no injection)', () => {
    const html = render('Hello <script>alert(1)</script> world');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises javascript: link protocols', () => {
    const html = render('[click me](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('click me');
  });

  it('does not normalise the completed (non-streaming) path', () => {
    // An open fence in a completed message is rendered as-is: react-markdown
    // treats the trailing prose as code. The wrapper must not silently inject a
    // closing fence for completed content.
    const html = render('```js\nconst x = 1;');
    expect(html).toContain('<code');
    // No balancing marker was appended by the component itself.
    expect(html).not.toContain('```');
  });
});

describe('normalizeStreamingMarkdown', () => {
  it('closes an unterminated fenced code block', () => {
    const out = normalizeStreamingMarkdown('```ts\nconst x = 1;');
    expect(out.match(/```/g)?.length).toBe(2);
  });

  it('leaves a balanced fenced code block untouched', () => {
    const src = '```ts\nconst x = 1;\n```';
    expect(normalizeStreamingMarkdown(src)).toBe(src);
  });

  it('balances a dangling inline code marker outside code blocks', () => {
    expect(normalizeStreamingMarkdown('use the `foo')).toBe('use the `foo`');
  });

  it('balances a dangling bold run', () => {
    expect(normalizeStreamingMarkdown('this is **important')).toBe('this is **important**');
  });

  it('does not miscount markers that live inside code spans', () => {
    // The lone `*` inside inline code and the fence contents must not trigger a
    // false balance.
    const src = 'run `a * b` then done';
    expect(normalizeStreamingMarkdown(src)).toBe(src);
  });

  it('is a no-op on empty input', () => {
    expect(normalizeStreamingMarkdown('')).toBe('');
  });

  it('renders an in-flight fence as a real code block when streaming', () => {
    const html = render('```js\nconst x = 1;', true);
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1;');
  });
});
