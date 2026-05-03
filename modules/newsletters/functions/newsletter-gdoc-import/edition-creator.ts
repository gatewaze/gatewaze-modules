/**
 * Edition Creator
 * Takes an AI mapping result and creates the edition + blocks + bricks in the database.
 */

import type { AIMappingResult } from './ai-mapper.ts';
import type { ImageMapping } from './image-processor.ts';
import { replaceImageUrls } from './image-processor.ts';
import { sanitizeBlockContent } from './sanitizer.ts';

// Static block types that get created with empty/default content
const STATIC_BLOCK_TYPES = new Set(['header', 'footer', 'toc', 'view_online']);

interface CreateEditionParams {
  supabase: any;
  collectionId: string;
  mapping: AIMappingResult;
  imageMappings: ImageMapping[];
  title: string;
  editionDate: string;
  status: string;
  importSource?: { docId: string; docTitle: string };
}

interface CreateEditionResult {
  editionId: string;
  blocksCreated: number;
  bricksCreated: number;
}

export async function createEditionFromMapping({
  supabase,
  collectionId,
  mapping,
  imageMappings,
  title,
  editionDate,
  status,
  importSource,
}: CreateEditionParams): Promise<CreateEditionResult> {
  // 1. Create edition
  const metadata: Record<string, unknown> = {};
  if (importSource) {
    metadata.import_source = {
      type: 'google_doc',
      doc_id: importSource.docId,
      doc_title: importSource.docTitle,
      imported_at: new Date().toISOString(),
    };
  }

  const { data: edition, error: editionError } = await supabase
    .from('newsletters_editions')
    .insert({
      title,
      edition_date: editionDate,
      status,
      collection_id: collectionId,
      metadata,
    })
    .select('id')
    .single();

  if (editionError) {
    throw new Error(`Failed to create edition: ${editionError.message}`);
  }

  // 2. Fetch block and brick templates for this library (collection.id == library.id).
  // `block_type` is aliased from templates_block_defs.key so the rest of
  // the function (Map-keyed lookups, AI prompt mapping) is unchanged.
  const { data: blockTemplates } = await supabase
    .from('templates_block_defs')
    .select('id, key, has_bricks, schema, block_type:key')
    .eq('library_id', collectionId);

  const { data: brickTemplates } = await supabase
    .from('templates_brick_defs')
    .select('id, key, block_def_id, schema, brick_type:key, templates_block_defs!inner(library_id)')
    .eq('templates_block_defs.library_id', collectionId);

  const blockTemplateMap = new Map(
    (blockTemplates || []).map((bt: any) => [bt.block_type, bt])
  );
  const brickTemplateMap = new Map(
    (brickTemplates || []).map((bt: any) => [bt.brick_type, bt])
  );

  let blocksCreated = 0;
  let bricksCreated = 0;

  // 3. Create AI-mapped blocks
  for (const block of mapping.blocks) {
    const template = blockTemplateMap.get(block.block_type);
    if (!template) continue; // Skip unknown block types

    // schema is now a top-level column on templates_block_defs.
    const schema = template.schema || null;

    // Sanitize content and replace image URLs
    let content = sanitizeBlockContent(block.content, schema);
    if (imageMappings.length > 0) {
      content = replaceImageUrls(content, imageMappings);
    }

    const { data: editionBlock, error: blockError } = await supabase
      .from('newsletters_edition_blocks')
      .insert({
        edition_id: edition.id,
        block_type: block.block_type,
        templates_block_def_id: template.id,
        sort_order: block.sort_order,
        content,
      })
      .select('id')
      .single();

    if (blockError) {
      console.error(`Failed to create block ${block.block_type}:`, blockError.message);
      continue;
    }

    blocksCreated++;

    // 4. Create bricks if present
    if (block.bricks && block.bricks.length > 0) {
      for (const brick of block.bricks) {
        const brickTemplate = brickTemplateMap.get(brick.brick_type);
        const brickSchema = brickTemplate?.schema || null;

        let brickContent = sanitizeBlockContent(brick.content, brickSchema);
        if (imageMappings.length > 0) {
          brickContent = replaceImageUrls(brickContent, imageMappings);
        }

        const { error: brickError } = await supabase
          .from('newsletters_edition_bricks')
          .insert({
            block_id: editionBlock.id,
            brick_type: brick.brick_type,
            templates_brick_def_id: brickTemplate?.id || null,
            sort_order: brick.sort_order,
            content: brickContent,
          });

        if (brickError) {
          console.error(`Failed to create brick ${brick.brick_type}:`, brickError.message);
          continue;
        }

        bricksCreated++;
      }
    }
  }

  // 5. Create static blocks with empty content.
  // templates_block_defs has no library-wide sort_order, so we order
  // static blocks by their `key` for deterministic placement.
  const maxSortOrder = Math.max(0, ...mapping.blocks.map((b) => b.sort_order));
  const staticBlocks = [...blockTemplateMap.entries()]
    .filter(([type]) => STATIC_BLOCK_TYPES.has(type))
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [blockType, template] of staticBlocks) {
    // Assign sort_order: header-like types go first, footer-like last
    let sortOrder: number;
    if (blockType === 'header' || blockType === 'view_online') {
      sortOrder = 0;
    } else if (blockType === 'toc') {
      sortOrder = 1;
    } else {
      sortOrder = maxSortOrder + 1;
    }

    const { error } = await supabase
      .from('newsletters_edition_blocks')
      .insert({
        edition_id: edition.id,
        block_type: blockType,
        templates_block_def_id: template.id,
        sort_order: sortOrder,
        content: {},
      });

    if (!error) blocksCreated++;
  }

  return {
    editionId: edition.id,
    blocksCreated,
    bricksCreated,
  };
}
