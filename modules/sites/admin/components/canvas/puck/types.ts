/**
 * Local types for the Puck adapter layer. Per
 * spec-builder-evaluation.md §3.2 / §3.3.
 *
 * These mirror what canvas-service / canvas-render already exposes, but
 * shape it for the diff algorithm (pre-tree snapshot + Puck Data target).
 * No new tables, no new wire formats — Puck reads/writes via the same
 * canvas-ops API as the legacy editor.
 */

export type ThemeKind = 'website' | 'email';

export interface BlockDefRow {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  schema: Record<string, unknown>;
  /** Mustache template HTML used by the client renderer. */
  html: string;
  has_bricks: boolean;
  is_current: boolean;
  /** Channel discriminator — Per spec-builder-evaluation §3.6. The
   *  Config adapter filters by themeKind so a website edit session
   *  doesn't surface email blocks (and vice versa) even when one
   *  library hosts both. */
  theme_kind: ThemeKind;
  thumbnail_url?: string | null;
}

export interface BrickDefRow {
  id: string;
  key: string;
  name: string;
  parent_block_def_key: string;
  parent_block_def_id: string;
  schema: Record<string, unknown>;
  /** Mustache template HTML for the brick. */
  html: string;
  is_current: boolean;
  /** Per spec §3.6 — bricks inherit their parent block's theme_kind by
   *  default but can override (rare). */
  theme_kind: ThemeKind;
}

export interface WrapperRow {
  id: string;
  key: string;
  schema?: Record<string, unknown>;
  is_current: boolean;
}

/**
 * Brick instance under a `has_bricks` block. Mirrors page_block_bricks rows.
 */
export interface PageBrickInstance {
  id: string;
  page_block_id: string;
  brick_def_key: string;
  brick_def_id: string;
  sort_order: number;
  variant_key: string;
  content: Record<string, unknown>;
}

/**
 * Block instance. Mirrors page_blocks rows.
 *
 * Note: `parent_brick_id` is set when this block sits inside another
 * block's brick slot. v1 of the Puck adapter does NOT yet handle
 * block-in-brick nesting (the deeper nesting case in the existing
 * model) — top-level blocks + their owned bricks only. Block-in-brick
 * is tracked in §16 open questions.
 */
export interface PageBlockInstance {
  id: string;
  block_def_key: string;
  block_def_id: string;
  parent_brick_id: string | null;
  sort_order: number;
  variant_key: string;
  has_bricks: boolean;
  content: Record<string, unknown>;
}

export interface PageMeta {
  id: string;
  wrapper_key: string | null;
  /** Editor uses the same root.props payload for both schema and blocks pages. */
  root_meta: Record<string, unknown>;
  wysiwyg_locked: boolean;
}

/**
 * The full pre-snapshot used by the diff algorithm. The editor caches
 * this on load; on save, we diff `nextData` against this snapshot to
 * produce the op stream — never against the live PuckData state.
 */
export interface PageBlockTree {
  page: PageMeta;
  topLevel: ReadonlyArray<PageBlockInstance>;
  bricks: ReadonlyArray<PageBrickInstance>;
}

/**
 * Subset of canvas/Render-host responsibilities the adapter needs.
 * The host owns the iframe bridge: live block render + media picker.
 */
export interface PuckRenderHost {
  /**
   * Server-side render of a single block — returns React element so Puck
   * can drop it into the iframe. Implementations call into the same
   * `renderPage`-derived pipeline as the legacy editor.
   */
  renderBlock(args: {
    blockDefKey: string;
    variantKey: string;
    content: Record<string, unknown>;
  }): React.ReactElement;

  /** Host-media picker — opens the existing media modal, returns URL on select. */
  showMediaPicker(cb: (url: string) => void): void;
}

/**
 * Puck Data shape (subset we use). The full type comes from @puckeditor/core;
 * we re-declare a narrowed version so the adapter unit tests can run
 * without dragging the editor bundle into the test environment.
 */
export interface PuckBlockProps {
  id: string;
  variant_key?: string;
  /** Slot for nested bricks when the block has `has_bricks=true`. */
  children?: ReadonlyArray<PuckBrickEntry>;
  /** Arbitrary block fields (mirrors page_blocks.content). */
  [k: string]: unknown;
}

export interface PuckBlockEntry {
  type: string;
  props: PuckBlockProps;
}

export interface PuckBrickProps {
  id: string;
  variant_key?: string;
  [k: string]: unknown;
}

export interface PuckBrickEntry {
  type: string;
  props: PuckBrickProps;
}

export interface PuckData {
  content: ReadonlyArray<PuckBlockEntry>;
  root: { props: Record<string, unknown> };
}

/**
 * Sentinel error thrown by the diff when an invariant fails. The editor
 * catches once, refetches the server snapshot, rebases, and retries.
 * On a second failure surfaces a "save conflict, please refresh" toast.
 */
export class RefetchRequired extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`refetch required: ${reason}`);
    this.name = 'RefetchRequired';
    this.reason = reason;
  }
}
