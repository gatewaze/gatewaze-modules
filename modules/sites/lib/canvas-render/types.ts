/**
 * Canvas-render shared types. Per spec-sites-wysiwyg-builder §5.1.
 *
 * The renderPage function is the SINGLE authoritative renderer used by both
 * the canvas editor (server-side) and (in Phase 2) the publish-worker.
 */

export interface BlockDefView {
  /** templates_block_defs.id */
  id: string;
  /** templates_block_defs.key (e.g. 'hero', 'row-2col') */
  key: string;
  /** Mustache template body. */
  html: string;
  /** JSON Schema for content validation. */
  schema: Record<string, unknown>;
  /** True if the template contains data-children attributes. */
  has_bricks: boolean;
  thumbnail_url: string | null;
}

export interface BrickDefView {
  id: string;
  /** templates_brick_defs.key (e.g. 'left' for a column slot) */
  key: string;
  html: string;
  schema: Record<string, unknown>;
}

export interface WrapperDefView {
  id: string;
  key: string;
  html: string;
}

export interface PageBlockNode {
  id: string;
  block_def_id: string;
  /** Per-instance content matching block_def.schema. */
  content: Record<string, unknown>;
  variant_key: string;
  sort_order: number;
  /** Bricks owned by this block, ordered by sort_order. */
  bricks: ReadonlyArray<PageBrickNode>;
  /** NULL = top-level. Set when this block is nested inside a parent brick slot. */
  parent_brick_id: string | null;
}

export interface PageBrickNode {
  id: string;
  brick_def_id: string;
  content: Record<string, unknown>;
  variant_key: string;
  sort_order: number;
  /** Child blocks nested into this brick slot. Empty unless the parent
   *  block_def's html declares data-children matching this brick's key. */
  children: ReadonlyArray<PageBlockNode>;
}

export interface RenderPageView {
  /** pages.id */
  id: string;
  /** pages.site_id */
  site_id: string;
  composition_mode: 'schema' | 'blocks';
  /** pages.wrapper_id — selects which wrapper template wraps the page body. */
  wrapper_id: string | null;
  /** Schema-mode pages only; blocks-mode pages have content='{}'. */
  content: Record<string, unknown> | null;
  /** Used in <title> + meta tags. */
  title: string;
  full_path: string;
}

export interface RenderInput {
  page: RenderPageView;
  /** Top-level blocks (parent_brick_id IS NULL), ordered by sort_order. */
  blocks: ReadonlyArray<PageBlockNode>;
  /** All block_defs referenced by `blocks` (and recursively, their children's blocks). */
  blockDefs: ReadonlyMap<string, BlockDefView>;
  /** All brick_defs referenced. */
  brickDefs: ReadonlyMap<string, BrickDefView>;
  /** All wrappers in scope (page wrapper + library default). */
  wrappers: ReadonlyMap<string, WrapperDefView>;
  /** site_media id → resolved url. */
  assets: ReadonlyMap<string, { url: string; alt?: string }>;
  /**
   * Per-block variant override. Editor-only. Empty map = use each block's
   * stored variant_key. Per spec-sites-wysiwyg-builder §5.1.
   */
  selectedBlockVariants?: ReadonlyMap<string, string>;
  /**
   * Per-block variant content overrides — block_id → variant_key → content.
   * The renderer consults this when selectedBlockVariants[block.id]
   * resolves to a non-default variant. Default content lives in
   * block.content (not in this map). Per spec §5.1 multi-variant follow-up.
   */
  blockVariants?: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>;
  /**
   * Per-brick variant content overrides — brick_id → variant_key → content.
   * Mirrors blockVariants for brick-slot content. Per spec §5.1.
   */
  brickVariants?: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>;
  context: {
    siteSlug: string;
    brand: string;
    /**
     * Affects DECORATION ONLY (script injection, data-* attribute
     * pass-through, omit analytics tags). Same body content regardless.
     */
    preview: boolean;
  };
}

export interface RenderWarning {
  code: string;
  message: string;
  blockId?: string;
}

export interface RenderResult {
  /** Complete HTML doc (doctype + <html>...). */
  html: string;
  /** sha256 of html, for ETag. */
  contentHash: string;
  warnings: ReadonlyArray<RenderWarning>;
}

// ----------------------------------------------------------------------------
// Canvas op envelope (request/response shapes for POST /admin/pages/:id/canvas)
// Per spec-sites-wysiwyg-builder §5.3.
// ----------------------------------------------------------------------------

export type CanvasOp =
  | { kind: 'block.insert'; afterBlockId: string | null; parentBrickId: string | null; blockDefKey: string; content: Record<string, unknown> }
  | { kind: 'block.move'; blockId: string; afterBlockId: string | null; parentBrickId: string | null }
  | { kind: 'block.delete'; blockId: string }
  | { kind: 'block.update_field'; blockId: string; fieldPath: string; newValue: unknown }
  | { kind: 'block.set_variant'; blockId: string; variantKey: string }
  | { kind: 'block.upsert_variant_content'; blockId: string; variantKey: string; content: Record<string, unknown> }
  | { kind: 'brick.insert'; pageBlockId: string; brickDefKey: string; afterBrickId: string | null; content: Record<string, unknown> }
  | { kind: 'brick.move'; brickId: string; afterBrickId: string | null }
  | { kind: 'brick.delete'; brickId: string }
  | { kind: 'brick.update_field'; brickId: string; fieldPath: string; newValue: unknown }
  | { kind: 'brick.upsert_variant_content'; brickId: string; variantKey: string; content: Record<string, unknown> }
  | { kind: 'preset.apply'; afterBlockId: string | null; parentBrickId: string | null; presetId: string };

export interface OpEnvelope {
  ops: ReadonlyArray<CanvasOp>;
  baseVersion: number;
  clientToken: string;
  idempotencyKey: string;
}

export interface ApplyOpsResponse {
  newVersion: number;
  render: RenderResult;
  warnings: ReadonlyArray<{ code: string; message: string }>;
  conflictDetail?: {
    actualVersion: number;
    actualEditor: { id: string; email: string };
  };
}
