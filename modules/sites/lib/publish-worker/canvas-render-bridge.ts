/**
 * Bridges the publish-worker's data model to the canvas-render module's
 * RenderInput shape, so the publisher can call the same `renderPage`
 * function the editor uses.
 *
 * Per spec-sites-wysiwyg-builder §3 + §5.1: decision (a) requires editor +
 * publisher share the SAME render code path. This module is the wiring
 * point — buildSiteContentFiles (publisher) calls renderPageForPublish()
 * for each blocks-mode page, writes the resulting HTML to a verification
 * artifact (`_verify/pages/<slug>.html`), and the render-parity test
 * cross-checks against a direct renderPage call.
 */

import {
  renderPage,
  type RenderInput,
  type RenderResult,
  type PageBlockNode,
  type PageBrickNode,
} from '../canvas-render/index.js';

export interface PublishRenderRow {
  id: string;
  page_id: string;
  block_def_id: string;
  parent_brick_id: string | null;
  sort_order: number;
  content: Record<string, unknown>;
  variant_key: string;
}

export interface PublishRenderBrickRow {
  id: string;
  page_block_id: string;
  brick_def_id: string;
  sort_order: number;
  content: Record<string, unknown>;
  variant_key: string;
}

export interface PublishRenderBlockDef {
  id: string;
  key: string;
  html: string;
  schema: Record<string, unknown>;
  has_bricks: boolean;
  thumbnail_url: string | null;
}

export interface PublishRenderBrickDef {
  id: string;
  key: string;
  html: string;
  schema: Record<string, unknown>;
}

export interface PublishRenderWrapper {
  id: string;
  key: string;
  html: string;
}

export interface RenderPageForPublishInput {
  page: {
    id: string;
    site_id: string;
    composition_mode: 'schema' | 'blocks';
    wrapper_id: string | null;
    content: Record<string, unknown> | null;
    title: string;
    full_path: string;
  };
  blocks: ReadonlyArray<PublishRenderRow>;
  bricks: ReadonlyArray<PublishRenderBrickRow>;
  blockDefs: ReadonlyMap<string, PublishRenderBlockDef>;
  brickDefs: ReadonlyMap<string, PublishRenderBrickDef>;
  wrappers: ReadonlyMap<string, PublishRenderWrapper>;
  assets: ReadonlyMap<string, { url: string; alt?: string }>;
  siteSlug: string;
  brand: string;
  /**
   * Optional variant overrides for multi-variant content. The publisher
   * passes these when emitting per-variant content files for an A/B
   * test (e.g. `content/pages/<slug>.<variant>.json`). Default
   * publishes use neither. Per spec-sites-wysiwyg-builder §5.1.
   */
  selectedBlockVariants?: ReadonlyMap<string, string>;
  blockVariants?: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>;
  brickVariants?: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>;
}

/**
 * Build the canvas-render RenderInput from the publisher's already-fetched
 * data, then call renderPage. Same code path the editor uses (decision (a)).
 *
 * `context.preview = false` here — no decorator script injection, no
 * editor-only data attributes. The rendered HTML is suitable for
 * publish-time verification.
 */
export function renderPageForPublish(input: RenderPageForPublishInput): RenderResult {
  const renderInput = buildRenderInput(input);
  return renderPage(renderInput);
}

function buildRenderInput(input: RenderPageForPublishInput): RenderInput {
  // Group bricks by parent block.
  const bricksByBlock = new Map<string, PublishRenderBrickRow[]>();
  for (const b of input.bricks) {
    const arr = bricksByBlock.get(b.page_block_id) ?? [];
    arr.push(b);
    bricksByBlock.set(b.page_block_id, arr);
  }

  // Group blocks by parent_brick_id.
  const blocksByBrick = new Map<string | null, PublishRenderRow[]>();
  for (const b of input.blocks) {
    const arr = blocksByBrick.get(b.parent_brick_id) ?? [];
    arr.push(b);
    blocksByBrick.set(b.parent_brick_id, arr);
  }

  function buildBlock(row: PublishRenderRow): PageBlockNode {
    const childBricks: PageBrickNode[] = (bricksByBlock.get(row.id) ?? []).map(buildBrick);
    return {
      id: row.id,
      block_def_id: row.block_def_id,
      content: row.content,
      variant_key: row.variant_key,
      sort_order: row.sort_order,
      parent_brick_id: row.parent_brick_id,
      bricks: childBricks,
    };
  }

  function buildBrick(row: PublishRenderBrickRow): PageBrickNode {
    const children: PageBlockNode[] = (blocksByBrick.get(row.id) ?? []).map(buildBlock);
    return {
      id: row.id,
      brick_def_id: row.brick_def_id,
      content: row.content,
      variant_key: row.variant_key,
      sort_order: row.sort_order,
      children,
    };
  }

  const topBlocks = (blocksByBrick.get(null) ?? []).map(buildBlock);

  return {
    page: input.page,
    blocks: topBlocks,
    blockDefs: input.blockDefs,
    brickDefs: input.brickDefs,
    wrappers: input.wrappers,
    assets: input.assets,
    ...(input.selectedBlockVariants ? { selectedBlockVariants: input.selectedBlockVariants } : {}),
    ...(input.blockVariants ? { blockVariants: input.blockVariants } : {}),
    ...(input.brickVariants ? { brickVariants: input.brickVariants } : {}),
    context: {
      siteSlug: input.siteSlug,
      brand: input.brand,
      preview: false, // publish-time, no editor decorators
    },
  };
}
