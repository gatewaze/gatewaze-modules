/**
 * Read-side data-access bridge.
 *
 * Loads block / brick defs preferring the templates module's tables; falls
 * back to the legacy newsletters tables when a row hasn't been migrated
 * yet. The fallback path goes away in migration 022 (drop legacy tables)
 * after all callers cut over.
 *
 * The Supabase shape is intentionally narrow — callers pass any client that
 * has a `from(table).select(...).eq(...).maybeSingle()` etc. surface.
 */

import {
  normalizeFromTemplatesBlockDef,
  normalizeLegacyBlockTemplates,
  normalizeFromTemplatesBrickDef,
  normalizeLegacyBrickTemplates,
} from './normalize.js';
import type { NewsletterBlockDef, NewsletterBrickDef } from './types.js';

export interface BridgeSupabaseClient {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        eq(col: string, val: unknown): {
          maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
        };
        in(col: string, vals: unknown[]): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
        order(col: string): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
        maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
      };
      in(col: string, vals: unknown[]): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Block defs
// ---------------------------------------------------------------------------

/**
 * Load all block defs for a library (collection in legacy terms).
 * Prefers templates_block_defs; falls back to legacy if the table is empty
 * for this library.
 */
export async function loadBlockDefsForLibrary(
  supabase: BridgeSupabaseClient,
  libraryId: string,
): Promise<NewsletterBlockDef[]> {
  const newRes = await supabase
    .from('templates_block_defs')
    .select('id, library_id, key, name, description, schema, html, rich_text_template, has_bricks')
    .eq('library_id', libraryId)
    .order('key');

  if (newRes.error) throw new Error(`templates_block_defs.select: ${newRes.error.message}`);
  const newRows = (newRes.data ?? []) as Array<Parameters<typeof normalizeFromTemplatesBlockDef>[0]>;
  if (newRows.length > 0) {
    return newRows.map(normalizeFromTemplatesBlockDef);
  }

  // Fallback: legacy table. Multiple variants per (collection, block_type) → collate.
  const legacyRes = await supabase
    .from('newsletters_block_templates')
    .select('id, collection_id, block_type, name, description, content, variant_key')
    .eq('collection_id', libraryId)
    .order('block_type');

  if (legacyRes.error) throw new Error(`newsletters_block_templates.select: ${legacyRes.error.message}`);
  const legacyRows = (legacyRes.data ?? []) as Array<Parameters<typeof normalizeLegacyBlockTemplates>[0][number]>;
  return normalizeLegacyBlockTemplates(legacyRows);
}

// ---------------------------------------------------------------------------
// Brick defs
// ---------------------------------------------------------------------------

export async function loadBrickDefsForBlockDef(
  supabase: BridgeSupabaseClient,
  blockDefId: string,
): Promise<NewsletterBrickDef[]> {
  const newRes = await supabase
    .from('templates_brick_defs')
    .select('id, block_def_id, key, name, schema, html, rich_text_template, sort_order')
    .eq('block_def_id', blockDefId)
    .order('sort_order');

  if (newRes.error) throw new Error(`templates_brick_defs.select: ${newRes.error.message}`);
  const newRows = (newRes.data ?? []) as Array<Parameters<typeof normalizeFromTemplatesBrickDef>[0]>;
  if (newRows.length > 0) {
    return newRows.map(normalizeFromTemplatesBrickDef);
  }

  const legacyRes = await supabase
    .from('newsletters_brick_templates')
    .select('id, block_template_id, brick_type, name, content, variant_key, sort_order')
    .eq('block_template_id', blockDefId)
    .order('sort_order');

  if (legacyRes.error) throw new Error(`newsletters_brick_templates.select: ${legacyRes.error.message}`);
  const legacyRows = (legacyRes.data ?? []) as Array<Parameters<typeof normalizeLegacyBrickTemplates>[0][number]>;
  return normalizeLegacyBrickTemplates(legacyRows);
}
