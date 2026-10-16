/**
 * End-to-end over the pure parts of the LFX import:
 *   bundle → source.html → (templates parser) → block defs → canvas
 *   validator → page plan → data fill → canonical render.
 *
 * The fixture is the Jupyter Foundation bundle produced by lfx-mos-website
 * 0.1.0 on 2026-10-16, unchanged.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse } from '../../../../templates/lib/parser/parse.js';
import { validateCanvasTemplate } from '../../canvas-validate-template/index.js';
import { renderPage } from '../../canvas-render/index.js';
import type { BlockDefView, PageBlockNode, WrapperDefView } from '../../canvas-render/types.js';
import { buildLfxSourceHtml, buildWrapperHtml, sanitiseCss, LFX_BLOCK_KEYS, LFX_WRAPPER_KEY, LFX_BLOCKS } from '../theme.js';
import { planPages } from '../pages.js';
import { fillBlockContent, resolveFill } from '../fill.js';
import { htmlPathFor } from '../../publish-worker/static-html.js';
import type { LfxBundle, LfxDataProvider, LfxSiteJson } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, '__fixtures__', 'jupyter');
const read = (p: string) => readFileSync(join(fx, p), 'utf8');

function loadBundle(): LfxBundle {
  return {
    site: JSON.parse(read('site.json')) as LfxSiteJson,
    css: read('assets/site.css'),
    js: read('assets/site.js'),
    logos: {
      light: read('assets/logo.svg'),
      reversed: read('assets/logo-reversed.svg'),
      favicon: read('assets/favicon.svg'),
    },
  };
}

const fakeProvider: LfxDataProvider = {
  async members({ limit }) {
    const rows = [
      { name: 'Anthropic', tier: 'platinum', tier_label: 'Platinum', logo_url: 'https://cdn.example/anthropic.svg', website_url: 'https://anthropic.com/' },
      { name: 'Google LLC', tier: 'platinum', tier_label: 'Platinum', logo_url: 'https://cdn.example/google.svg', website_url: 'https://google.com/' },
      { name: 'No Logo Co', tier: 'gold', tier_label: 'Gold', logo_url: '', website_url: '' },
    ];
    return typeof limit === 'number' ? rows.slice(0, limit) : rows;
  },
  async memberTiers() {
    return [
      { name: 'Platinum', mist: false, members: [{ name: 'Anthropic', logo_url: 'https://cdn.example/anthropic.svg', website_url: 'https://anthropic.com/' }] },
      { name: 'Gold', mist: true, members: [{ name: 'No Logo Co', logo_url: '', website_url: '' }] },
    ];
  },
  async upcomingEvents(limit) {
    return [
      { name: 'AGNTCon + MCPCon North America', date: 'Oct 22, 2026', location: 'San Jose, US', url: 'https://events.linuxfoundation.org/agntcon' },
      { name: 'MCP Dev Summit Nairobi', date: 'Nov 19, 2026', location: 'Nairobi, KE', url: '' },
    ].slice(0, limit);
  },
  async latestPosts(limit) {
    return [
      { title: 'Agentgateway v1.3.0 <released>', date: 'Jul 6, 2026', author: 'AAIF', excerpt: 'LLM consumption, reimagined.', url: '/blog/agentgateway' },
    ].slice(0, limit);
  },
};

describe('LFX theme source.html', () => {
  const bundle = loadBundle();
  const sourceHtml = buildLfxSourceHtml(bundle);
  const parsed = parse(sourceHtml, { sourcePath: 'lfx-theme.html' });

  it('parses with no errors and yields one wrapper plus every block', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.wrappers.map((w) => w.key)).toEqual([LFX_WRAPPER_KEY]);
    expect(parsed.block_defs.map((b) => b.key).sort()).toEqual([...LFX_BLOCK_KEYS].sort());
  });

  it('keeps the brand CSS, fonts, logos and chrome in the wrapper', () => {
    const w = parsed.wrappers[0]!;
    expect(w.html).toContain('--btn:#F37625');
    expect(w.html).toContain('fonts.googleapis.com/css2?family=Montserrat');
    expect(w.html).toContain('data:image/svg+xml');
    expect(w.html).toContain('Get Jupyter Foundation news in your inbox');
    expect(w.html).toContain('href="/about/governing-board/"');
    expect((w.html.match(/\{\{content\}\}/g) ?? []).length).toBe(1);
  });

  it('never embeds the bundle script and sanitises the bundle stylesheet', () => {
    const hostile = {
      ...bundle,
      js: 'window.parent.postMessage("pwned","*")',
      css: `body{color:red}</style><script>alert(1)</script><style>@import url("https://evil.example/x.css");.a{background:url(https://evil.example/t.png)}.b{background:url(data:image/png;base64,AAAA)}.c{background:url(/assets/ok.png)}.d::after{content:"{{content}}"}`,
    };
    const w = buildWrapperHtml(hostile);
    expect(w).not.toContain('pwned');
    expect(w).toContain('lf-cookie-choice');
    expect(w).not.toContain('</style><script>');
    expect(w).not.toContain('@import');
    expect(w).not.toContain('evil.example');
    expect(w).toContain('url(data:image/png;base64,AAAA)');
    expect(w).toContain('url(/assets/ok.png)');
    // Exactly one body slot survives: the real one in <main>.
    expect((w.match(/\{\{content\}\}/g) ?? []).length).toBe(1);
    expect(sanitiseCss('a{b:url("//cdn.example/x")}')).toBe('a{b:url()}');
  });

  it('only emits safe URL schemes from site.json into the chrome', () => {
    const w = buildWrapperHtml({
      ...bundle,
      site: {
        ...bundle.site,
        announcement: { text: 'Hi <b>there</b>', link: 'javascript:alert(1)' },
        signup: { ...bundle.site.signup, endpoint: 'http://attacker.example/collect' },
        project: { ...bundle.site.project, name: 'X --> <!-- BLOCK:evil | name=e --><p>{{content}}</p><!-- /BLOCK:evil -->' },
      },
    });
    expect(w).toContain('<div class="announce">Hi &lt;b&gt;there&lt;/b&gt;</div>');
    expect(w).not.toContain('javascript:');
    expect(w).not.toContain('attacker.example');
    expect(w).toContain('data-endpoint="" action="#"');
    expect(w).not.toContain('<!-- BLOCK:evil');
    expect((w.match(/\{\{content\}\}/g) ?? []).length).toBe(1);
  });

  it('every block passes the canvas template validator', () => {
    for (const def of parsed.block_defs) {
      const result = validateCanvasTemplate({ html: def.html, schema: def.schema, brickDefKeys: [] });
      expect(result, def.key).toEqual({ valid: true });
    }
  });

  it('records the data fill on the data-backed block defs', () => {
    const byKey = new Map(parsed.block_defs.map((b) => [b.key, b]));
    for (const spec of LFX_BLOCKS) {
      const def = byKey.get(spec.key)!;
      if (spec.fill) {
        expect(def.data_source).toEqual({ adapter: 'gatewaze', operation: 'lfx.fill', params: spec.fill });
      } else {
        expect(def.data_source).toBeNull();
      }
    }
  });

  it('declares only Puck-friendly schemas (arrays of objects, no scalar arrays)', () => {
    const walk = (schema: Record<string, unknown>, path: string) => {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [k, p] of Object.entries(props)) {
        if (p.type === 'array') {
          const items = p.items as Record<string, unknown> | undefined;
          expect(items?.type, `${path}${k}`).toBe('object');
          walk(items!, `${path}${k}[].`);
        }
      }
    };
    for (const def of parsed.block_defs) walk(def.schema, `${def.key}.`);
  });
});

describe('page plan', () => {
  const bundle = loadBundle();
  const plan = planPages(bundle.site);

  it('plans the eleven generated pages with the generator paths', () => {
    expect(plan.map((p) => p.full_path)).toEqual([
      '/', '/about', '/about/governing-board', '/about/technical-committee', '/about/members',
      '/about/contact', '/events', '/news', '/get-involved', '/join', '/campaign',
    ]);
    expect(plan.filter((p) => p.is_homepage).map((p) => p.slug)).toEqual(['index']);
    expect(plan.find((p) => p.slug === 'members')!.parent_path).toBe('/about');
  });

  it('mirrors the home page section order', () => {
    const home = plan[0]!;
    expect(home.blocks.map((b) => b.key)).toEqual([
      'lfx_hero', 'lfx_stats', 'lfx_pillars', 'lfx_member_logos', 'lfx_events_news', 'lfx_faq', 'lfx_cta_band',
    ]);
    expect(home.blocks[0]!.content.headline).toBe('Open standards for interactive computing');
    expect(home.blocks[2]!.content.items).toHaveLength(3);
  });

  it('only uses block keys that exist in the theme', () => {
    const keys = new Set<string>(LFX_BLOCK_KEYS);
    for (const page of plan) for (const b of page.blocks) expect(keys.has(b.key), b.key).toBe(true);
  });

  it('marks the News page card grid as blog-backed per instance', () => {
    const news = plan.find((p) => p.slug === 'news')!;
    expect(news.blocks[1]!.fill).toEqual({ fields: { items: { source: 'blog.latest', limit: 12, shape: 'cards' } } });
  });
});

describe('data fill', () => {
  it('instance config wins over the def data_source', () => {
    const def = { adapter: 'gatewaze', operation: 'lfx.fill', params: { fields: { events: { source: 'events.upcoming', limit: 3 } } } };
    expect(resolveFill(def, null)).toEqual(def.params);
    expect(resolveFill(def, { fill: { fields: { events: { source: 'events.upcoming', limit: 9 } } } })!.fields.events).toEqual({ source: 'events.upcoming', limit: 9 });
    expect(resolveFill({ adapter: 'http', operation: 'x' }, null)).toBeNull();
    expect(resolveFill(def, { fill: { fields: { bad: {} } } })).toEqual(def.params);
  });

  it('rejects editor-supplied fill configs that are out of bounds', () => {
    const base = { adapter: 'gatewaze', operation: 'lfx.fill', params: { fields: { events: { source: 'events.upcoming', limit: 3 } } } };
    const bad = [
      { fields: { events: { source: 'events.upcoming', limit: 0 } } },
      { fields: { events: { source: 'events.upcoming', limit: 5000 } } },
      { fields: { events: { source: 'events.upcoming', limit: 2.5 } } },
      { fields: { members: { source: 'membership.members', tiers: ['platinum', "x' or 1=1"] } } },
      { fields: { x: { source: 'people.all' } } },
      { fields: { 'drop table': { source: 'events.upcoming' } } },
      { fields: {} },
    ];
    for (const kc of bad) expect(resolveFill(base, { fill: kc }), JSON.stringify(kc)).toEqual(base.params);
    expect(resolveFill(base, { fill: { fields: { members: { source: 'membership.members', limit: 100, tiers: ['platinum'] } } } })).not.toEqual(base.params);
  });

  it('static output paths reject traversal and reserved names', () => {
    expect(htmlPathFor('/')).toBe('index.html');
    expect(htmlPathFor('/about/governing-board')).toBe('about/governing-board/index.html');
    expect(htmlPathFor('/../etc')).toBeNull();
    expect(htmlPathFor('/content/pages')).toBeNull();
    expect(htmlPathFor('/sitemap.xml')).toBeNull();
    expect(htmlPathFor('/.git/config')).toBeNull();
    expect(htmlPathFor('/a b')).toBeNull();
  });

  it('replaces only the filled fields and reports provider failures per field', async () => {
    const broken: LfxDataProvider = { ...fakeProvider, async latestPosts() { throw new Error('blog down'); } };
    const out = await fillBlockContent(
      { events_title: 'Upcoming', events: [{ name: '[Event name]' }], posts: [{ title: '[Launch]' }] },
      { fields: { events: { source: 'events.upcoming', limit: 1 }, posts: { source: 'blog.latest', limit: 3 } } },
      broken,
    );
    expect(out.content.events_title).toBe('Upcoming');
    expect(out.content.events).toEqual([expect.objectContaining({ name: 'AGNTCon + MCPCon North America' })]);
    expect(out.content.posts).toEqual([{ title: '[Launch]' }]);
    expect(out.errors).toEqual([{ field: 'posts', message: 'blog down' }]);
  });
});

describe('canonical render of the imported home page', () => {
  it('renders a full document with the brand CSS, filled data and escaped copy', async () => {
    const bundle = loadBundle();
    const parsed = parse(buildLfxSourceHtml(bundle));
    const defs = new Map<string, BlockDefView>();
    const idByKey = new Map<string, string>();
    parsed.block_defs.forEach((d, i) => {
      const id = `def-${i}`;
      idByKey.set(d.key, id);
      defs.set(id, { id, key: d.key, html: d.html, schema: d.schema, has_bricks: d.has_bricks, thumbnail_url: null });
    });
    const wrapper: WrapperDefView = { id: 'wrap-1', key: LFX_WRAPPER_KEY, html: parsed.wrappers[0]!.html };

    const home = planPages(bundle.site)[0]!;
    const blocks: PageBlockNode[] = [];
    for (let i = 0; i < home.blocks.length; i++) {
      const b = home.blocks[i]!;
      const def = parsed.block_defs.find((d) => d.key === b.key)!;
      const fill = resolveFill(def.data_source as { adapter?: string; operation?: string; params?: unknown } | null, b.fill ? { fill: b.fill } : null);
      const content = fill ? (await fillBlockContent(b.content, fill, fakeProvider)).content : b.content;
      blocks.push({ id: `blk-${i}`, block_def_id: idByKey.get(b.key)!, content, variant_key: 'default', sort_order: (i + 1) * 1000, parent_brick_id: null, bricks: [] });
    }

    const result = renderPage({
      page: { id: 'page-1', site_id: 'site-1', composition_mode: 'blocks', wrapper_id: 'wrap-1', content: null, title: home.title, full_path: '/' },
      blocks,
      blockDefs: defs,
      brickDefs: new Map(),
      wrappers: new Map([['wrap-1', wrapper]]),
      assets: new Map(),
      context: { siteSlug: 'jupyter', brand: 'aaif', preview: false },
    });

    expect(result.warnings).toEqual([]);
    const html = result.html;
    // One document, not a document nested in a document.
    expect((html.match(/<!doctype html>/gi) ?? []).length).toBe(1);
    expect((html.match(/<html\b/gi) ?? []).length).toBe(1);
    expect(html).toContain('<body data-canvas-page-id="page-1">');
    expect((html.match(/Content-Security-Policy/g) ?? []).length).toBe(1);
    expect(html).toContain('<title>Jupyter Foundation: Open standards for interactive computing</title>');
    expect(html).toContain('--btn:#F37625');
    // The wrapper slot got the blocks.
    expect(html).toContain('<h1>Open standards for interactive computing</h1>');
    expect(html).toContain('<li class="stat"><b>40+</b>');
    // Data-backed sections carry AAIF rows, with real links and escaped text.
    expect(html).toContain('<img src="https://cdn.example/anthropic.svg" alt="Anthropic"');
    expect(html).toContain('<li class="logo-slot ">No Logo Co</li>');
    expect(html).toContain('<a href="https://events.linuxfoundation.org/agntcon">AGNTCon + MCPCon North America</a>');
    expect(html).toContain('Agentgateway v1.3.0 &lt;released&gt;');
    // No editor decoration on a publish render.
    expect(html).not.toContain('canvas:ready');
  });

  it('injects the editor decorator into a full-document wrapper in preview mode', () => {
    const wrapper: WrapperDefView = { id: 'w', key: 'k', html: '<!doctype html><html><head><title>{{page.title}}</title></head><body><main>{{content}}</main></body></html>' };
    const def: BlockDefView = { id: 'd', key: 'p', html: '<p data-block-root>{{text}}</p>', schema: { type: 'object', properties: { text: { type: 'string' } } }, has_bricks: false, thumbnail_url: null };
    const result = renderPage({
      page: { id: 'pg', site_id: 's', composition_mode: 'blocks', wrapper_id: 'w', content: null, title: 'T', full_path: '/' },
      blocks: [{ id: 'b1', block_def_id: 'd', content: { text: 'hi' }, variant_key: 'default', sort_order: 1000, parent_brick_id: null, bricks: [] }],
      blockDefs: new Map([['d', def]]),
      brickDefs: new Map(),
      wrappers: new Map([['w', wrapper]]),
      assets: new Map(),
      context: { siteSlug: 's', brand: 'b', preview: true },
    });
    expect(result.html).toMatch(/<head>\n<meta http-equiv="Content-Security-Policy"[^>]*>\n<script>[\s\S]*canvas:ready[\s\S]*<\/script><title>T<\/title><\/head>/);
    expect(result.html).toContain('<main><p data-block-id="b1" data-block-root>hi</p></main>');
    expect(result.html).toContain('<body data-canvas-page-id="pg">');
  });
});
