// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Render-parity test — verifies decision (a) per spec-sites-wysiwyg-builder
 * §10. The editor and publisher MUST produce byte-identical HTML for the
 * same page state, because they call the same `renderPage` function.
 *
 * The test:
 *   1. Constructs fixture pages (single block, columns, nested, missing
 *      fields, asset resolution, wrapper).
 *   2. Calls `renderPage` directly (representing the editor's path).
 *   3. Calls `renderPageForPublish` (the publisher's bridge — should
 *      converge on the same `renderPage` call internally).
 *   4. Asserts the output HTML is byte-identical and the contentHash
 *      matches.
 *
 * If anyone forks the rendering logic (e.g. adds a publisher-only
 * transformation), this test fails and signals the drift.
 */

import { describe, expect, it } from 'vitest';
import { renderPage, type RenderInput, type BlockDefView, type PageBlockNode } from '../../canvas-render/index.js';
import { renderPageForPublish, type RenderPageForPublishInput, type PublishRenderRow } from '../canvas-render-bridge.js';

const BASE_PAGE = {
  id: '00000000-0000-0000-0000-000000000001',
  site_id: '00000000-0000-0000-0000-000000000002',
  composition_mode: 'blocks' as const,
  wrapper_id: null,
  content: null,
  title: 'Parity Test Page',
  full_path: '/parity',
};

function makeBlockDef(partial: Partial<BlockDefView>): BlockDefView {
  return {
    id: 'def-' + (partial.key ?? 'x'),
    key: partial.key ?? 'x',
    html: partial.html ?? '<div>{{title}}</div>',
    schema: partial.schema ?? { type: 'object' },
    has_bricks: partial.has_bricks ?? false,
    thumbnail_url: null,
  };
}

function makeBlock(partial: Partial<PageBlockNode>): PageBlockNode {
  return {
    id: partial.id ?? 'block-1',
    block_def_id: partial.block_def_id ?? 'def-x',
    content: partial.content ?? {},
    variant_key: partial.variant_key ?? 'default',
    sort_order: partial.sort_order ?? 1000,
    bricks: partial.bricks ?? [],
    parent_brick_id: partial.parent_brick_id ?? null,
  };
}

function blockDefMap(...defs: BlockDefView[]): ReadonlyMap<string, BlockDefView> {
  return new Map(defs.map((d) => [d.id, d]));
}

/**
 * Convert an editor RenderInput's flat top-block list into the publisher's
 * flat-rows shape (page_blocks + page_block_bricks). The bridge then
 * reconstructs the tree and calls renderPage.
 */
function flattenBlocks(blocks: ReadonlyArray<PageBlockNode>): { blocks: PublishRenderRow[]; bricks: ReturnType<typeof flattenBlocksInner>['bricks'] } {
  const inner = flattenBlocksInner(blocks);
  return { blocks: inner.blocks, bricks: inner.bricks };
}

function flattenBlocksInner(blocks: ReadonlyArray<PageBlockNode>): {
  blocks: PublishRenderRow[];
  bricks: Array<{ id: string; page_block_id: string; brick_def_id: string; sort_order: number; content: Record<string, unknown>; variant_key: string }>;
} {
  const allBlocks: PublishRenderRow[] = [];
  const allBricks: Array<{ id: string; page_block_id: string; brick_def_id: string; sort_order: number; content: Record<string, unknown>; variant_key: string }> = [];
  const stack: PageBlockNode[] = [...blocks];
  while (stack.length > 0) {
    const b = stack.shift()!;
    allBlocks.push({
      id: b.id,
      page_id: BASE_PAGE.id,
      block_def_id: b.block_def_id,
      parent_brick_id: b.parent_brick_id,
      sort_order: b.sort_order,
      content: b.content,
      variant_key: b.variant_key,
    });
    for (const brick of b.bricks) {
      allBricks.push({
        id: brick.id,
        page_block_id: b.id,
        brick_def_id: brick.brick_def_id,
        sort_order: brick.sort_order,
        content: brick.content,
        variant_key: brick.variant_key,
      });
      stack.push(...brick.children);
    }
  }
  return { blocks: allBlocks, bricks: allBricks };
}

function publishInputFromEditorInput(editorInput: RenderInput): RenderPageForPublishInput {
  const { blocks, bricks } = flattenBlocks(editorInput.blocks);
  return {
    page: editorInput.page,
    blocks,
    bricks,
    blockDefs: editorInput.blockDefs,
    brickDefs: editorInput.brickDefs,
    wrappers: editorInput.wrappers,
    assets: editorInput.assets,
    siteSlug: editorInput.context.siteSlug,
    brand: editorInput.context.brand,
  };
}

const FIXTURES: Array<{ name: string; input: () => RenderInput }> = [
  {
    name: 'single block',
    input: () => {
      const def = makeBlockDef({ key: 'h1', html: '<h1 data-block-root>{{title}}</h1>' });
      return {
        page: BASE_PAGE,
        blocks: [makeBlock({ block_def_id: def.id, content: { title: 'Hello' } })],
        blockDefs: blockDefMap(def),
        brickDefs: new Map(),
        wrappers: new Map(),
        assets: new Map(),
        context: { siteSlug: 'parity', brand: 'parity', preview: false },
      };
    },
  },
  {
    name: 'multiple blocks ordered',
    input: () => {
      const a = makeBlockDef({ key: 'a', html: '<p data-block-root>A:{{name}}</p>' });
      const b = makeBlockDef({ key: 'b', html: '<p data-block-root>B:{{name}}</p>' });
      return {
        page: BASE_PAGE,
        blocks: [
          makeBlock({ id: '1', block_def_id: a.id, content: { name: 'one' }, sort_order: 1000 }),
          makeBlock({ id: '2', block_def_id: b.id, content: { name: 'two' }, sort_order: 2000 }),
        ],
        blockDefs: blockDefMap(a, b),
        brickDefs: new Map(),
        wrappers: new Map(),
        assets: new Map(),
        context: { siteSlug: 'parity', brand: 'parity', preview: false },
      };
    },
  },
  {
    name: 'sections + escapes',
    input: () => {
      const def = makeBlockDef({ key: 'cond', html: '<div data-block-root>{{#show}}<span>{{value}}</span>{{/show}}</div>' });
      return {
        page: BASE_PAGE,
        blocks: [makeBlock({ block_def_id: def.id, content: { show: true, value: '<bad>' } })],
        blockDefs: blockDefMap(def),
        brickDefs: new Map(),
        wrappers: new Map(),
        assets: new Map(),
        context: { siteSlug: 'parity', brand: 'parity', preview: false },
      };
    },
  },
  {
    name: 'columns (2-col with nested children)',
    input: () => {
      const colDef = makeBlockDef({
        key: 'row-2col',
        html: '<div data-block-root class="row">{{>left}}{{>right}}</div>',
        has_bricks: true,
      });
      const innerDef = makeBlockDef({ key: 'h2', html: '<h2 data-block-root>{{text}}</h2>' });
      const leftBrickDef = { id: 'brick-left-def', key: 'left', html: '<div class="col">{{>children}}</div>', schema: {} };
      const rightBrickDef = { id: 'brick-right-def', key: 'right', html: '<div class="col">{{>children}}</div>', schema: {} };

      return {
        page: BASE_PAGE,
        blocks: [
          {
            ...makeBlock({ id: 'col', block_def_id: colDef.id }),
            bricks: [
              {
                id: 'brick-l', brick_def_id: leftBrickDef.id, content: {}, variant_key: 'default', sort_order: 1000,
                children: [makeBlock({ id: 'inner-l', block_def_id: innerDef.id, content: { text: 'left' }, parent_brick_id: 'brick-l' })],
              },
              {
                id: 'brick-r', brick_def_id: rightBrickDef.id, content: {}, variant_key: 'default', sort_order: 2000,
                children: [makeBlock({ id: 'inner-r', block_def_id: innerDef.id, content: { text: 'right' }, parent_brick_id: 'brick-r' })],
              },
            ],
          },
        ],
        blockDefs: blockDefMap(colDef, innerDef),
        brickDefs: new Map([
          [leftBrickDef.id, leftBrickDef],
          [rightBrickDef.id, rightBrickDef],
        ]),
        wrappers: new Map(),
        assets: new Map(),
        context: { siteSlug: 'parity', brand: 'parity', preview: false },
      };
    },
  },
  {
    name: 'wrapper substitution',
    input: () => {
      const def = makeBlockDef({ key: 'p', html: '<p data-block-root>{{text}}</p>' });
      const wrapper = { id: 'wrap-1', key: 'default', html: '<main><h1>{{page.title}}</h1>{{>page_body}}</main>' };
      return {
        page: { ...BASE_PAGE, wrapper_id: wrapper.id },
        blocks: [makeBlock({ block_def_id: def.id, content: { text: 'inner' } })],
        blockDefs: blockDefMap(def),
        brickDefs: new Map(),
        wrappers: new Map([[wrapper.id, wrapper]]),
        assets: new Map(),
        context: { siteSlug: 'parity', brand: 'parity', preview: false },
      };
    },
  },
  {
    name: 'asset resolution',
    input: () => {
      const def = makeBlockDef({ key: 'img', html: '<img data-block-root src="{{image.url}}" alt="{{image.alt}}">' });
      return {
        page: BASE_PAGE,
        blocks: [makeBlock({ block_def_id: def.id, content: { image: { id: 'media-x' } } })],
        blockDefs: blockDefMap(def),
        brickDefs: new Map(),
        wrappers: new Map(),
        assets: new Map([['media-x', { url: '/m/abc.jpg', alt: 'Photo' }]]),
        context: { siteSlug: 'parity', brand: 'parity', preview: false },
      };
    },
  },
  {
    name: 'missing field renders as empty string',
    input: () => {
      const def = makeBlockDef({ key: 'x', html: '<p data-block-root>before {{missing}} after</p>' });
      return {
        page: BASE_PAGE,
        blocks: [makeBlock({ block_def_id: def.id, content: {} })],
        blockDefs: blockDefMap(def),
        brickDefs: new Map(),
        wrappers: new Map(),
        assets: new Map(),
        context: { siteSlug: 'parity', brand: 'parity', preview: false },
      };
    },
  },
];

describe('render parity — editor vs publisher', () => {
  for (const fixture of FIXTURES) {
    it(`produces byte-identical HTML: ${fixture.name}`, () => {
      const editorInput = fixture.input();
      const editorResult = renderPage(editorInput);

      const publishInput = publishInputFromEditorInput(editorInput);
      const publishResult = renderPageForPublish(publishInput);

      expect(publishResult.html).toBe(editorResult.html);
      expect(publishResult.contentHash).toBe(editorResult.contentHash);
    });
  }

  it('verifies all 7 representative fixtures', () => {
    expect(FIXTURES).toHaveLength(7);
  });
});
