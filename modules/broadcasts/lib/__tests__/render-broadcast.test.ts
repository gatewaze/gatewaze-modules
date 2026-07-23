import { describe, it, expect } from 'vitest';
import { renderBroadcastBody, DEFAULT_BROADCAST_SHELL, type RenderableBlock } from '../render-broadcast.js';
import { buildBroadcastLinkRows } from '../broadcast-links.js';
import { tagHtmlLinks, type LinkSourceBlock } from '../link-tracking.js';

describe('renderBroadcastBody', () => {
  it('concatenates richtext blocks in sort order (bare body when no shell)', () => {
    const blocks: RenderableBlock[] = [
      { id: 'b2', block_type: 'richtext', sort_order: 1, content: { html: '<p>second</p>' } },
      { id: 'b1', block_type: 'richtext', sort_order: 0, content: { html: '<p>first</p>' } },
    ];
    const { html, skipped } = renderBroadcastBody(blocks);
    expect(html).toBe('<p>first</p>\n<p>second</p>');
    expect(skipped).toEqual([]);
  });

  it('wraps body in the shell and injects the (escaped) preheader', () => {
    const blocks: RenderableBlock[] = [
      { id: 'b1', block_type: 'richtext', sort_order: 0, content: { html: '<p>hi</p>' } },
    ];
    const { html } = renderBroadcastBody(blocks, { shell: DEFAULT_BROADCAST_SHELL, preheader: 'A & B <x>' });
    expect(html).toContain('<p>hi</p>');
    expect(html).toContain('width="600"');
    expect(html).toContain('A &amp; B &lt;x&gt;');
    expect(html).not.toContain('{{body}}');
    expect(html).not.toContain('{{preheader}}');
  });

  it('skips def-backed blocks empty-safe and reports them', () => {
    const blocks: RenderableBlock[] = [
      { id: 'b1', block_type: 'richtext', sort_order: 0, content: { html: '<p>intro</p>' } },
      { id: 'v1', block_type: 'video', sort_order: 1, content: { videos: [] } },
    ];
    const { html, skipped } = renderBroadcastBody(blocks);
    expect(html).toBe('<p>intro</p>');
    expect(skipped).toEqual(['v1']);
  });

  it('empty richtext produces empty body, no crash', () => {
    const blocks: RenderableBlock[] = [
      { id: 'b1', block_type: 'richtext', sort_order: 0, content: { html: '' } },
    ];
    expect(renderBroadcastBody(blocks).html).toBe('');
  });

  it('rendered links survive tagging: hrefs in the body get their ?nlb= keys', () => {
    const src: LinkSourceBlock[] = [
      { id: 'b1', block_type: 'richtext', sort_order: 0, content: { html: '<p><a href="https://x.com/go">go</a></p>' } },
    ];
    const { taggable, rows } = buildBroadcastLinkRows('BC1', src);
    const { html } = renderBroadcastBody(
      src.map((b) => ({ id: b.id, block_type: b.block_type, sort_order: b.sort_order, content: b.content })),
    );
    const tagged = tagHtmlLinks(html, taggable);
    expect(tagged).toContain(`nlb=${rows[0].tracking_key}`);
    expect(tagged).toContain('https://x.com/go?nlb=');
  });
});
