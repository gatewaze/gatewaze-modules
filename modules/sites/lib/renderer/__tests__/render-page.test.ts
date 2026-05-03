import { describe, expect, it } from 'vitest';
import { renderPage, type RenderInput } from '../render-page.js';
import type { PageRow, SiteRow } from '../../../types/index.js';

const page: Pick<PageRow, 'id' | 'title' | 'full_path' | 'seo' | 'host_kind' | 'host_id'> = {
  id: 'p1', title: 'About', full_path: '/about', seo: {}, host_kind: 'site', host_id: 's1',
};
const site: Pick<SiteRow, 'id' | 'slug' | 'name' | 'config'> = {
  id: 's1', slug: 'aaif', name: 'AAIF', config: {},
};

describe('renderPage()', () => {
  it('composes a single block + bricks into the wrapper', () => {
    const input: RenderInput = {
      page,
      site,
      wrapper: {
        id: 'w1',
        html_template: '<!doctype html><html><head><title>{{page.title}}</title></head><body>{{>page_body}}</body></html>',
      },
      blocks: [
        {
          block: { id: 'b1', sort_order: 0, content: { heading: 'Hello' }, variant_key: 'default' },
          blockDef: {
            id: 'd1',
            html_template: '<section><h2>{{heading}}</h2><ul>{{#bricks}}{{{html}}}{{/bricks}}</ul></section>',
          },
          bricks: [
            {
              brick: { id: 'br1', sort_order: 0, content: { label: 'first' }, variant_key: 'default' },
              brickDef: { id: 'bd1', html_template: '<li>{{label}}</li>' },
            },
            {
              brick: { id: 'br2', sort_order: 1, content: { label: 'second' }, variant_key: 'default' },
              brickDef: { id: 'bd1', html_template: '<li>{{label}}</li>' },
            },
          ],
        },
      ],
    };
    const out = renderPage(input);
    expect(out.html).toContain('<title>About</title>');
    expect(out.html).toContain('<h2>Hello</h2>');
    expect(out.html).toContain('<li>first</li>');
    expect(out.html).toContain('<li>second</li>');
    expect(out.stats.blocksRendered).toBe(1);
    expect(out.stats.bricksRendered).toBe(2);
  });

  it('orders blocks and bricks by sort_order regardless of input order', () => {
    const input: RenderInput = {
      page,
      site,
      wrapper: { id: 'w1', html_template: '<body>{{>page_body}}</body>' },
      blocks: [
        {
          block: { id: 'b2', sort_order: 1, content: {}, variant_key: 'default' },
          blockDef: { id: 'd1', html_template: '<p>two</p>' },
          bricks: [],
        },
        {
          block: { id: 'b1', sort_order: 0, content: {}, variant_key: 'default' },
          blockDef: { id: 'd1', html_template: '<p>one</p>' },
          bricks: [],
        },
      ],
    };
    const out = renderPage(input);
    expect(out.html.indexOf('<p>one</p>')).toBeLessThan(out.html.indexOf('<p>two</p>'));
  });

  it('throws if the wrapper template lacks {{>page_body}} (defensive — lint should catch)', () => {
    const input: RenderInput = {
      page,
      site,
      wrapper: { id: 'w1', html_template: '<body>no body partial</body>' },
      blocks: [],
    };
    expect(() => renderPage(input)).toThrow(/wrapper_missing_page_body_partial/);
  });

  it('renders empty blocks list as empty body', () => {
    const input: RenderInput = {
      page,
      site,
      wrapper: { id: 'w1', html_template: '<body>{{>page_body}}</body>' },
      blocks: [],
    };
    const out = renderPage(input);
    expect(out.html).toBe('<body></body>');
    expect(out.stats.blocksRendered).toBe(0);
    expect(out.stats.bricksRendered).toBe(0);
  });

  it('escapes user content from page.title in the wrapper', () => {
    const input: RenderInput = {
      page: { ...page, title: 'Pwn <script>alert(1)</script>' },
      site,
      wrapper: { id: 'w1', html_template: '<title>{{page.title}}</title><body>{{>page_body}}</body>' },
      blocks: [],
    };
    const out = renderPage(input);
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<script>alert(1)</script>');
  });

  it('handles a null site (e.g., portal-host pages)', () => {
    const input: RenderInput = {
      page,
      site: null,
      wrapper: { id: 'w1', html_template: '<body>{{>page_body}}</body>' },
      blocks: [],
    };
    expect(() => renderPage(input)).not.toThrow();
  });
});
