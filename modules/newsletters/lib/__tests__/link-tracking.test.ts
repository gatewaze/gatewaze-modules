import { describe, it, expect } from 'vitest';
import {
  isTrackableUrl,
  extractHtmlHrefs,
  extractTrackableLinks,
  generateTrackingKey,
  tagUrl,
  parseNlb,
  tagHtmlLinks,
  type LinkSourceBlock,
} from '../link-tracking.js';

describe('isTrackableUrl', () => {
  it('accepts http/https/relative', () => {
    expect(isTrackableUrl('https://x.com')).toBe(true);
    expect(isTrackableUrl('http://x.com')).toBe(true);
    expect(isTrackableUrl('/foo')).toBe(true);
  });
  it('rejects non-trackable schemes and tokens', () => {
    expect(isTrackableUrl('mailto:a@b.com')).toBe(false);
    expect(isTrackableUrl('tel:+1')).toBe(false);
    expect(isTrackableUrl('#anchor')).toBe(false);
    expect(isTrackableUrl('{% unsubscribe_url %}')).toBe(false);
    expect(isTrackableUrl('{{ shop_link }}')).toBe(false);
    expect(isTrackableUrl('https://x.com/unsubscribe')).toBe(false);
    expect(isTrackableUrl('')).toBe(false);
  });
});

describe('extractHtmlHrefs', () => {
  it('extracts hrefs in document order (both quote styles)', () => {
    const html = `<a href="https://a.com">a</a> <a href='https://b.com'>b</a>`;
    expect(extractHtmlHrefs(html)).toEqual(['https://a.com', 'https://b.com']);
  });
});

describe('extractTrackableLinks', () => {
  const blocks: LinkSourceBlock[] = [
    {
      id: 'b1', block_type: 'hot_take', sort_order: 0,
      content: { title: 'T', body: '<p>see <a href="https://x.com/1">x</a> and <a href="https://x.com/2">y</a></p>' },
    },
    {
      id: 'b2', block_type: 'job_of_week', sort_order: 1, tracking_slug: 'jobs',
      content: {
        jobs: [
          { job_title: 'Eng', apply_link: 'https://apply.com/eng', description: '<p><a href="https://apply.com/eng">apply</a></p>' },
          { job_title: 'PM', apply_link: 'mailto:hr@co.com' },
        ],
      },
    },
    {
      id: 'b3', block_type: 'community', sort_order: 2,
      content: {},
      bricks: [
        { id: 'k1', brick_type: 'podcast', sort_order: 0, content: { description: '<a href="https://pod.com">listen</a>' } },
      ],
    },
  ];

  it('extracts links from rich text, link fields, and bricks in order', () => {
    const occ = extractTrackableLinks(blocks);
    const urls = occ.map((o) => o.original_url);
    expect(urls).toEqual([
      'https://x.com/1',
      'https://x.com/2',
      'https://apply.com/eng', // jobs[0].apply_link (scalar link field)
      'https://apply.com/eng', // jobs[0].description rich text
      'https://pod.com',       // brick
    ]);
  });

  it('excludes mailto and gives stable (block,field,index) keys', () => {
    const occ = extractTrackableLinks(blocks);
    // no mailto
    expect(occ.find((o) => o.original_url.startsWith('mailto:'))).toBeUndefined();
    // two links in the same body share field, sequential index
    const body = occ.filter((o) => o.block_id === 'b1');
    expect(body.map((o) => [o.field, o.link_index])).toEqual([['body', 0], ['body', 1]]);
    // slug + brick wiring
    expect(occ.find((o) => o.block_id === 'b2')?.tracking_slug).toBe('jobs');
    expect(occ.find((o) => o.brick_id === 'k1')?.block_type).toBe('community');
  });
});

describe('generateTrackingKey', () => {
  it('is 10 url-safe base62 chars and unique enough', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateTrackingKey()));
    expect([...keys][0]).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(keys.size).toBe(1000);
  });
});

describe('tagUrl / parseNlb', () => {
  it('appends nlb, preserving query + fragment', () => {
    expect(tagUrl('https://x.com/p', 'KEY')).toBe('https://x.com/p?nlb=KEY');
    expect(tagUrl('https://x.com/p?a=1', 'KEY')).toBe('https://x.com/p?a=1&nlb=KEY');
    expect(tagUrl('https://x.com/p?a=1#frag', 'KEY')).toBe('https://x.com/p?a=1&nlb=KEY#frag');
  });
  it('is idempotent — replaces an existing nlb instead of duplicating', () => {
    const once = tagUrl('https://x.com?a=1', 'K1');
    expect(tagUrl(once, 'K2')).toBe('https://x.com?a=1&nlb=K2');
  });
  it('round-trips through parseNlb (last value wins)', () => {
    expect(parseNlb(tagUrl('https://x.com', 'abc'))).toBe('abc');
    expect(parseNlb('https://x.com?nlb=A&b=2&nlb=B')).toBe('B');
    expect(parseNlb('https://x.com?a=1')).toBeNull();
    expect(parseNlb('https://x.com')).toBeNull();
  });
});

describe('tagHtmlLinks', () => {
  it('tags each registry link in order, handling duplicate URLs distinctly', () => {
    const html = `<a href="https://dup.com">1</a><a href="https://dup.com">2</a><a href="https://other.com">o</a>`;
    const rows = [
      { original_url: 'https://dup.com', tracking_key: 'K1' },
      { original_url: 'https://dup.com', tracking_key: 'K2' },
      { original_url: 'https://other.com', tracking_key: 'K3' },
    ];
    const out = tagHtmlLinks(html, rows);
    expect(out).toBe(
      `<a href="https://dup.com?nlb=K1">1</a><a href="https://dup.com?nlb=K2">2</a><a href="https://other.com?nlb=K3">o</a>`,
    );
  });
  it('leaves untracked anchors untouched', () => {
    const html = `<a href="https://tracked.com">t</a><a href="https://static.com">s</a>`;
    const out = tagHtmlLinks(html, [{ original_url: 'https://tracked.com', tracking_key: 'K' }]);
    expect(out).toBe(`<a href="https://tracked.com?nlb=K">t</a><a href="https://static.com">s</a>`);
  });
});
