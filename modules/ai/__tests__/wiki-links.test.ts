import { describe, it, expect } from 'vitest';
import { parseLinks, parseLinksForPage, RAW_PREFIX } from '../lib/wiki/links.js';

describe('parseLinks (wikilinks only)', () => {
  it('extracts same-wiki, cross-wiki, and raw links with dedupe + alias strip', () => {
    const body = [
      'See [[meta/trends/mcp]] and [[meta/trends/mcp|MCP trends]] (dupe).',
      'Cross: [[techtickets:speakers/jane-doe]].',
      'Source: [[raw:submissions/1208848]].',
      'Bad: [[Has Space]] should be dropped.',
    ].join('\n');
    const links = parseLinks(body, 'cfp');
    expect(links).toContainEqual({ to_use_case: 'cfp', to_slug: 'meta/trends/mcp' });
    expect(links).toContainEqual({ to_use_case: 'techtickets', to_slug: 'speakers/jane-doe' });
    expect(links).toContainEqual({ to_use_case: `${RAW_PREFIX}cfp`, to_slug: 'submissions/1208848' });
    expect(links.filter((l) => l.to_slug === 'meta/trends/mcp')).toHaveLength(1); // deduped
    expect(links.some((l) => /Has Space/.test(l.to_slug))).toBe(false);
  });
});

describe('parseLinksForPage (wikilinks + markdown relative)', () => {
  it('also resolves markdown .md relative links against the source slug', () => {
    const from = 'conferences/mumbai/submissions/1208848';
    const body = 'Speaker [Kaiwalya](../speakers/kaiwalya.md); topic [[meta/topics/gateways]].';
    const links = parseLinksForPage(body, 'cfp', from);
    expect(links).toContainEqual({ to_use_case: 'cfp', to_slug: 'conferences/mumbai/speakers/kaiwalya' });
    expect(links).toContainEqual({ to_use_case: 'cfp', to_slug: 'meta/topics/gateways' });
  });
  it('routes a markdown link under raw/ to a raw link', () => {
    const links = parseLinksForPage('[src](../../raw/submissions/9.md)', 'cfp', 'conferences/mumbai/x');
    expect(links).toContainEqual({ to_use_case: `${RAW_PREFIX}cfp`, to_slug: 'submissions/9' });
  });
  it('ignores external links', () => {
    const links = parseLinksForPage('[site](https://example.com/a.md)', 'cfp', 'a');
    expect(links).toHaveLength(0);
  });
});
