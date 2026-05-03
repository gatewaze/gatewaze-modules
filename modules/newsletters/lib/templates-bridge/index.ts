/**
 * Newsletter ↔ templates module bridge.
 *
 * The newsletter module is in transition from its own block/brick template
 * tables to the shared templates module. This bridge:
 *
 *   - Exposes a normalized read-side type (NewsletterBlockDef /
 *     NewsletterBrickDef)
 *   - Loads from templates_block_defs / templates_brick_defs preferentially
 *   - Falls back to the legacy newsletters_block_templates /
 *     newsletters_brick_templates if a library hasn't been migrated yet
 *
 * Callers stop caring which table backs the data. Migration 022 drops the
 * legacy tables once the admin UI is fully cut over.
 */

export type { NewsletterBlockDef, NewsletterBrickDef } from './types.js';
export {
  normalizeFromTemplatesBlockDef,
  normalizeFromTemplatesBrickDef,
  normalizeLegacyBlockTemplates,
  normalizeLegacyBrickTemplates,
} from './normalize.js';
export {
  loadBlockDefsForLibrary,
  loadBrickDefsForBlockDef,
  type BridgeSupabaseClient,
} from './load.js';
