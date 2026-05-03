/**
 * Type bridge between newsletter's legacy block/brick template shape and
 * the templates module's templates_block_defs / templates_brick_defs.
 *
 * The legacy tables stored multiple rows per (collection, block_type) — one
 * per variant_key (html_template / substack / beehiiv). The new templates
 * module holds 1 row per (library, key) with `html` (canonical text) and
 * `rich_text_template` (Substack/Beehiiv-style outputs).
 *
 * This module exposes a single normalized read shape so callers don't
 * need to know which underlying table holds the data.
 */

/** Normalized read-side shape consumed by output adapters + the editor. */
export interface NewsletterBlockDef {
  /** The block_def's UUID (same as legacy block_template.id where applicable). */
  id: string;
  /** Stable per-library identifier (legacy block_type). */
  key: string;
  /** Library / collection id. */
  library_id: string;
  /** Display name (e.g., "Header"). */
  name: string;
  description: string | null;
  /** JSON Schema for content. May be {} if untyped. */
  schema: Record<string, unknown>;
  /** Canonical HTML body. Used by the HTML output adapter and the editor preview. */
  html: string;
  /** Optional rich-text body for Substack / Beehiiv outputs. */
  rich_text_template: string | null;
  has_bricks: boolean;
  /** Whether this row was loaded from the new templates module (true) or
   * the legacy newsletters_block_templates fallback (false). */
  source: 'templates_block_defs' | 'legacy';
}

export interface NewsletterBrickDef {
  id: string;
  key: string;
  block_def_id: string;
  name: string;
  schema: Record<string, unknown>;
  html: string;
  rich_text_template: string | null;
  sort_order: number;
  source: 'templates_brick_defs' | 'legacy';
}
