// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Performance benchmark for canvas renderPage. Per spec-sites-wysiwyg-
 * builder §8 the editor's render path must complete < 50 ms for a
 * representative 50-block page on commodity hardware. The bench
 * here measures three sizes (10, 50, 200 blocks) so we can spot
 * regressions early. Run with:
 *
 *     pnpm --filter @gatewaze-modules/sites exec vitest bench
 *
 * Numbers are reported as ops/sec; slower implementations appear at
 * the bottom of the table. Wire-CI does not enforce a threshold —
 * this is signal for humans, not a gate.
 */

import { bench, describe } from 'vitest';
import { renderPage } from '../render-page.js';
import type { RenderInput, BlockDefView, PageBlockNode } from '../types.js';

const PAGE: RenderInput['page'] = {
  id: '00000000-0000-0000-0000-000000000001',
  site_id: '00000000-0000-0000-0000-000000000002',
  composition_mode: 'blocks',
  wrapper_id: null,
  content: null,
  title: 'Bench Page',
  full_path: '/bench',
};

const CONTEXT = { siteSlug: 'bench', brand: 'bench', preview: false } as const;

const defHero: BlockDefView = {
  id: 'def-hero',
  key: 'hero',
  html: '<section data-block-root class="hero"><h1>{{title}}</h1><p>{{tagline}}</p></section>',
  schema: { type: 'object' },
  has_bricks: false,
  thumbnail_url: null,
};

const defParagraph: BlockDefView = {
  id: 'def-p',
  key: 'paragraph',
  html: '<p data-block-root>{{body}}</p>',
  schema: { type: 'object' },
  has_bricks: false,
  thumbnail_url: null,
};

const defImage: BlockDefView = {
  id: 'def-img',
  key: 'image',
  html: '<figure data-block-root><img src="{{image.url}}" alt="{{image.alt}}"/><figcaption>{{caption}}</figcaption></figure>',
  schema: { type: 'object' },
  has_bricks: false,
  thumbnail_url: null,
};

const defConditional: BlockDefView = {
  id: 'def-cond',
  key: 'cta',
  html: '<div data-block-root>{{#show}}<a href="{{href}}">{{label}}</a>{{/show}}</div>',
  schema: { type: 'object' },
  has_bricks: false,
  thumbnail_url: null,
};

const BLOCK_DEFS: ReadonlyMap<string, BlockDefView> = new Map([
  [defHero.id, defHero],
  [defParagraph.id, defParagraph],
  [defImage.id, defImage],
  [defConditional.id, defConditional],
]);

const ROTATION = [defHero.id, defParagraph.id, defImage.id, defConditional.id];

function makeBlocks(n: number): PageBlockNode[] {
  const out: PageBlockNode[] = [];
  for (let i = 0; i < n; i++) {
    const defId = ROTATION[i % ROTATION.length] ?? defParagraph.id;
    const content = defId === defHero.id
      ? { title: `Block ${i}`, tagline: `tagline #${i}` }
      : defId === defImage.id
        ? { caption: `caption #${i}`, image: { id: 'media-x' } }
        : defId === defConditional.id
          ? { show: i % 2 === 0, href: '/cta', label: `cta-${i}` }
          : { body: `paragraph body for block ${i} — some more text to keep this realistic` };
    out.push({
      id: `block-${i}`,
      block_def_id: defId,
      content,
      variant_key: 'default',
      sort_order: (i + 1) * 1000,
      bricks: [],
      parent_brick_id: null,
    });
  }
  return out;
}

function makeInput(n: number): RenderInput {
  return {
    page: PAGE,
    blocks: makeBlocks(n),
    blockDefs: BLOCK_DEFS,
    brickDefs: new Map(),
    wrappers: new Map(),
    assets: new Map([['media-x', { url: '/m/abc.jpg', alt: 'Photo' }]]),
    context: CONTEXT,
  };
}

const small = makeInput(10);
const medium = makeInput(50);
const large = makeInput(200);

describe('renderPage performance', () => {
  bench('10 blocks (small page)', () => {
    renderPage(small);
  });
  bench('50 blocks (typical page — spec target < 50ms)', () => {
    renderPage(medium);
  });
  bench('200 blocks (worst case — CANVAS_BLOCK_COUNT_MAX)', () => {
    renderPage(large);
  });
});
