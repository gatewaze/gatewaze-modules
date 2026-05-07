// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Multi-variant content rendering tests. Per spec-sites-wysiwyg-builder
 * §5.1 the editor (and Phase 2 the publisher) must be able to render a
 * block with content that depends on the active variant_key. The
 * RenderInput now carries:
 *   - selectedBlockVariants: which variant the renderer should pick
 *     for each block (overrides each block's stored variant_key)
 *   - blockVariants:         block_id → variant_key → content overrides
 *   - brickVariants:         brick_id → variant_key → content overrides
 *
 * Resolution rule (renderOneBlock + buildBrickPartials):
 *   variantKey = selectedBlockVariants[blockId] ?? block.variant_key ?? 'default'
 *   if variantKey === 'default'       → use block.content
 *   else if blockVariants[id][key]    → use override content
 *   else                              → fall back to block.content
 *
 * These tests pin that resolution; render-parity-with-publisher is
 * separately tested in publish-worker/__tests__/render-parity.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { renderPage } from '../render-page.js';
import type { RenderInput, BlockDefView, BrickDefView, PageBlockNode, PageBrickNode } from '../types.js';

const PAGE = {
  id: '00000000-0000-0000-0000-000000000001',
  site_id: '00000000-0000-0000-0000-000000000002',
  composition_mode: 'blocks' as const,
  wrapper_id: null,
  content: null,
  title: 'Variant Test',
  full_path: '/v',
};

const CONTEXT = { siteSlug: 'v', brand: 'v', preview: false } as const;

function defHero(): BlockDefView {
  return {
    id: 'def-hero',
    key: 'hero',
    html: '<section data-block-root><h1>{{title}}</h1></section>',
    schema: { type: 'object' },
    has_bricks: false,
    thumbnail_url: null,
  };
}

function block(id: string, content: Record<string, unknown>, variantKey = 'default'): PageBlockNode {
  return {
    id,
    block_def_id: 'def-hero',
    content,
    variant_key: variantKey,
    sort_order: 1000,
    bricks: [],
    parent_brick_id: null,
  };
}

function inputWith(overrides: Partial<RenderInput>): RenderInput {
  return {
    page: PAGE,
    blocks: [],
    blockDefs: new Map([[defHero().id, defHero()]]),
    brickDefs: new Map(),
    wrappers: new Map(),
    assets: new Map(),
    context: CONTEXT,
    ...overrides,
  };
}

describe('renderPage — multi-variant content', () => {
  it('renders default content when no variant override is selected', () => {
    const r = renderPage(inputWith({
      blocks: [block('blk-1', { title: 'Default Title' })],
    }));
    expect(r.html).toContain('Default Title');
  });

  it('falls back to default when selectedBlockVariants names an unknown variant', () => {
    const r = renderPage(inputWith({
      blocks: [block('blk-1', { title: 'Default Title' })],
      selectedBlockVariants: new Map([['blk-1', 'no-such-variant']]),
    }));
    expect(r.html).toContain('Default Title');
  });

  it('uses the override content when selectedBlockVariants matches a stored variant', () => {
    const r = renderPage(inputWith({
      blocks: [block('blk-1', { title: 'Default' })],
      selectedBlockVariants: new Map([['blk-1', 'v2']]),
      blockVariants: new Map([
        ['blk-1', new Map([['v2', { title: 'Variant Two' }]])],
      ]),
    }));
    expect(r.html).toContain('Variant Two');
    expect(r.html).not.toContain('Default');
  });

  it('respects block.variant_key when selectedBlockVariants is absent', () => {
    // The block itself was saved with variant_key='v3'; no editor override
    // is provided, so the renderer should pick the v3 content.
    const r = renderPage(inputWith({
      blocks: [block('blk-1', { title: 'Default' }, 'v3')],
      blockVariants: new Map([
        ['blk-1', new Map([['v3', { title: 'Stored V3 Content' }]])],
      ]),
    }));
    expect(r.html).toContain('Stored V3 Content');
  });

  it('selectedBlockVariants overrides block.variant_key', () => {
    const r = renderPage(inputWith({
      blocks: [block('blk-1', { title: 'Default' }, 'v3')],
      selectedBlockVariants: new Map([['blk-1', 'v4']]),
      blockVariants: new Map([
        ['blk-1', new Map([
          ['v3', { title: 'V3 Content' }],
          ['v4', { title: 'V4 Content (selected)' }],
        ])],
      ]),
    }));
    expect(r.html).toContain('V4 Content (selected)');
    expect(r.html).not.toContain('V3 Content');
  });

  it('different blocks can render different variants in the same page', () => {
    const r = renderPage(inputWith({
      blocks: [
        block('blk-1', { title: 'A default' }),
        block('blk-2', { title: 'B default' }),
      ],
      selectedBlockVariants: new Map([
        ['blk-1', 'v2'],
        // blk-2 has no override → default
      ]),
      blockVariants: new Map([
        ['blk-1', new Map([['v2', { title: 'A variant 2' }]])],
        ['blk-2', new Map([['v2', { title: 'B variant 2' }]])], // not selected for blk-2
      ]),
    }));
    expect(r.html).toContain('A variant 2');
    expect(r.html).toContain('B default');
    expect(r.html).not.toContain('A default');
    expect(r.html).not.toContain('B variant 2');
  });

  it('produces stable contentHash for the same variant selection', () => {
    const buildInput = () => inputWith({
      blocks: [block('blk-1', { title: 'Default' })],
      selectedBlockVariants: new Map([['blk-1', 'v2']]),
      blockVariants: new Map([['blk-1', new Map([['v2', { title: 'Variant Two' }]])]]),
    });
    const a = renderPage(buildInput());
    const b = renderPage(buildInput());
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.html).toBe(b.html);
  });

  it('different variant selections produce different contentHashes', () => {
    const baseBlocks = [block('blk-1', { title: 'Default' })];
    const variants = new Map([['blk-1', new Map([
      ['v1', { title: 'Title V1' }],
      ['v2', { title: 'Title V2' }],
    ])]]);
    const a = renderPage(inputWith({
      blocks: baseBlocks,
      selectedBlockVariants: new Map([['blk-1', 'v1']]),
      blockVariants: variants,
    }));
    const b = renderPage(inputWith({
      blocks: baseBlocks,
      selectedBlockVariants: new Map([['blk-1', 'v2']]),
      blockVariants: variants,
    }));
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe('renderPage — multi-variant brick content', () => {
  function brickDef(): BrickDefView {
    return {
      id: 'def-cta-brick',
      key: 'cta',
      html: '<a class="cta">{{label}}</a>{{>children}}',
      schema: { type: 'object' },
    };
  }

  function containerDef(): BlockDefView {
    return {
      id: 'def-container',
      key: 'container',
      html: '<div data-block-root>{{>cta}}</div>',
      schema: { type: 'object' },
      has_bricks: true,
      thumbnail_url: null,
    };
  }

  function brick(id: string, content: Record<string, unknown>, variantKey = 'default'): PageBrickNode {
    return {
      id,
      brick_def_id: 'def-cta-brick',
      content,
      variant_key: variantKey,
      sort_order: 1000,
      children: [],
    };
  }

  it('uses default brick content when no variant is selected', () => {
    const r = renderPage({
      page: PAGE,
      blocks: [{
        id: 'blk-1', block_def_id: 'def-container',
        content: {}, variant_key: 'default', sort_order: 1000,
        bricks: [brick('brk-1', { label: 'Click me' })],
        parent_brick_id: null,
      }],
      blockDefs: new Map([[containerDef().id, containerDef()]]),
      brickDefs: new Map([[brickDef().id, brickDef()]]),
      wrappers: new Map(),
      assets: new Map(),
      context: CONTEXT,
    });
    expect(r.html).toContain('Click me');
  });

  it('renders the brick variant override when selected', () => {
    const r = renderPage({
      page: PAGE,
      blocks: [{
        id: 'blk-1', block_def_id: 'def-container',
        content: {}, variant_key: 'default', sort_order: 1000,
        bricks: [brick('brk-1', { label: 'Default CTA' })],
        parent_brick_id: null,
      }],
      blockDefs: new Map([[containerDef().id, containerDef()]]),
      brickDefs: new Map([[brickDef().id, brickDef()]]),
      wrappers: new Map(),
      assets: new Map(),
      context: CONTEXT,
      selectedBlockVariants: new Map([['brk-1', 'urgent']]),
      brickVariants: new Map([
        ['brk-1', new Map([['urgent', { label: 'Limited time!' }]])],
      ]),
    });
    expect(r.html).toContain('Limited time!');
    expect(r.html).not.toContain('Default CTA');
  });
});
