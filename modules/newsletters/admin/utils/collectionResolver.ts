/**
 * Collection-Aware Template Resolver
 *
 * Resolves block and brick templates for a given collection and output variant.
 * Used by output adapters to fetch the correct templates and by the editor
 * to filter templates by collection.
 *
 * Reads from the templates module's tables (templates_block_defs /
 * templates_brick_defs). The legacy newsletters_block_templates path is
 * gone as of PR 16.b. The `collectionId` argument matches a
 * templates_libraries.id (migration 021 maps the legacy collection.id
 * 1-to-1 onto the library row id).
 */

import { supabase } from '@/lib/supabase';

export interface ResolvedBlockTemplate {
  id: string;
  block_type: string;
  name: string;
  template: string;
  has_bricks: boolean;
  schema: Record<string, unknown>;
  sort_order: number;
}

export interface ResolvedBrickTemplate {
  id: string;
  brick_type: string;
  name: string;
  template: string;
  schema: Record<string, unknown>;
  sort_order: number;
}

interface CollectionInfo {
  id: string;
  name: string;
  slug: string;
  is_default: boolean;
}

/**
 * Get the default template collection
 */
export async function getDefaultCollection(): Promise<CollectionInfo | null> {
  const { data, error } = await supabase
    .from('newsletters_template_collections')
    .select('id, name, slug, is_default')
    .eq('is_default', true)
    .single();

  if (error) {
    console.error('Error fetching default collection:', error);
    return null;
  }

  return data;
}

/**
 * Get a template collection by slug
 */
export async function getCollectionBySlug(slug: string): Promise<CollectionInfo | null> {
  const { data, error } = await supabase
    .from('newsletters_template_collections')
    .select('id, name, slug, is_default')
    .eq('slug', slug)
    .single();

  if (error) return null;
  return data;
}

function pickTemplate(
  variantKey: string,
  html: string | null,
  richTextTemplate: string | null,
): string {
  if (variantKey === 'rich_text_template' || variantKey === 'substack' || variantKey === 'beehiiv') {
    return richTextTemplate ?? html ?? '';
  }
  return html ?? '';
}

/**
 * Resolve block templates for a given collection (templates library) and variant key.
 */
export async function resolveBlockTemplates(
  collectionId: string,
  variantKey: string = 'html_template'
): Promise<ResolvedBlockTemplate[]> {
  // sort_order is not on templates_block_defs (no per-library ordering yet)
  // — order by `key` for stable presentation.
  const { data, error } = await supabase
    .from('templates_block_defs')
    .select('id, key, name, html, rich_text_template, schema, has_bricks')
    .eq('library_id', collectionId)
    .order('key');

  if (error) {
    console.error('Error fetching block templates:', error);
    return [];
  }

  return (data || []).map((row, idx) => ({
    id: row.id,
    block_type: row.key,
    name: row.name,
    template: pickTemplate(variantKey, row.html, row.rich_text_template),
    has_bricks: row.has_bricks ?? false,
    schema: (row.schema && typeof row.schema === 'object' ? row.schema : {}) as Record<string, unknown>,
    sort_order: idx,
  }));
}

/**
 * Resolve brick templates for a given collection (templates library) and variant key.
 *
 * Bricks are parented by templates_block_defs; we join to filter by library.
 */
export async function resolveBrickTemplates(
  collectionId: string,
  variantKey: string = 'html_template'
): Promise<ResolvedBrickTemplate[]> {
  // PostgREST inner-embed select to filter bricks by parent block_def's library.
  const { data, error } = await supabase
    .from('templates_brick_defs')
    .select('id, key, name, html, rich_text_template, schema, sort_order, templates_block_defs!inner(library_id)')
    .eq('templates_block_defs.library_id', collectionId)
    .order('sort_order');

  if (error) {
    console.error('Error fetching brick templates:', error);
    return [];
  }

  return (data || []).map(row => ({
    id: row.id,
    brick_type: row.key,
    name: row.name,
    template: pickTemplate(variantKey, row.html, row.rich_text_template),
    schema: (row.schema && typeof row.schema === 'object' ? row.schema : {}) as Record<string, unknown>,
    sort_order: row.sort_order ?? 0,
  }));
}

/**
 * Resolve all templates for an edition, using the edition's collection_id
 * or falling back to the default collection.
 */
export async function resolveEditionTemplates(
  editionCollectionId: string | null,
  variantKey: string = 'html_template'
): Promise<{
  blocks: ResolvedBlockTemplate[];
  bricks: ResolvedBrickTemplate[];
  collectionId: string;
}> {
  let collectionId = editionCollectionId;

  // Fall back to default collection
  if (!collectionId) {
    const defaultCollection = await getDefaultCollection();
    if (!defaultCollection) {
      return { blocks: [], bricks: [], collectionId: '' };
    }
    collectionId = defaultCollection.id;
  }

  const [blocks, bricks] = await Promise.all([
    resolveBlockTemplates(collectionId, variantKey),
    resolveBrickTemplates(collectionId, variantKey),
  ]);

  return { blocks, bricks, collectionId };
}

/**
 * List all available template collections
 */
export async function listCollections(): Promise<CollectionInfo[]> {
  const { data, error } = await supabase
    .from('newsletters_template_collections')
    .select('id, name, slug, is_default')
    .order('is_default', { ascending: false })
    .order('name');

  if (error) {
    console.error('Error listing collections:', error);
    return [];
  }

  return data || [];
}
