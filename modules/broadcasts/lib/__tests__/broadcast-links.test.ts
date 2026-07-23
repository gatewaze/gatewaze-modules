import { describe, it, expect } from 'vitest';
import { buildBroadcastLinkRows, occurrenceKey } from '../broadcast-links.js';
import { tagHtmlLinks, type LinkSourceBlock } from '../link-tracking.js';

const blocks: LinkSourceBlock[] = [
  {
    id: 'b1', block_type: 'content_section', sort_order: 0,
    content: { heading: 'Recap', body: '<p><a href="https://x.com/a">a</a> <a href="https://x.com/b">b</a></p>' },
  },
  {
    id: 'b2', block_type: 'video', sort_order: 1, tracking_slug: 'recommended',
    content: { videos: [{ watch_link: 'https://youtu.be/k' }] },
  },
];

describe('buildBroadcastLinkRows', () => {
  it('produces one row per trackable occurrence with the broadcast id stamped', () => {
    const { rows } = buildBroadcastLinkRows('BC1', blocks);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.broadcast_id === 'BC1')).toBe(true);
    expect(rows.map((r) => r.original_url)).toEqual([
      'https://x.com/a',
      'https://x.com/b',
      'https://youtu.be/k',
    ]);
    // stable occurrence keys + denormalized fields carried through
    expect(rows[0]).toMatchObject({ block_id: 'b1', field: 'body', link_index: 0, block_type: 'content_section' });
    expect(rows[1]).toMatchObject({ block_id: 'b1', field: 'body', link_index: 1 });
    expect(rows[2]).toMatchObject({ block_id: 'b2', tracking_slug: 'recommended', block_type: 'video' });
  });

  it('generates distinct keys and taggable list in document order', () => {
    const { rows, taggable } = buildBroadcastLinkRows('BC1', blocks);
    const keys = new Set(rows.map((r) => r.tracking_key));
    expect(keys.size).toBe(3);
    expect(taggable.map((t) => t.original_url)).toEqual(rows.map((r) => r.original_url));
    expect(taggable.map((t) => t.tracking_key)).toEqual(rows.map((r) => r.tracking_key));
  });

  it('reuses existing tracking_keys so historical attribution survives a re-render', () => {
    const first = buildBroadcastLinkRows('BC1', blocks);
    const existing = new Map(
      first.rows.map((r) => [occurrenceKey(r.block_id, r.field, r.link_index), r.tracking_key]),
    );
    const second = buildBroadcastLinkRows('BC1', blocks, existing);
    expect(second.rows.map((r) => r.tracking_key)).toEqual(first.rows.map((r) => r.tracking_key));
  });

  it('feeds tagHtmlLinks so rendered HTML carries matching ?nlb= keys', () => {
    const { rows, taggable } = buildBroadcastLinkRows('BC1', blocks);
    const html = `<a href="https://x.com/a">a</a><a href="https://x.com/b">b</a><a href="https://youtu.be/k">k</a>`;
    const tagged = tagHtmlLinks(html, taggable);
    for (const r of rows) {
      expect(tagged).toContain(`nlb=${r.tracking_key}`);
    }
  });
});
