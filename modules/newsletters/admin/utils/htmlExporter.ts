/**
 * HTML Template Exporter
 *
 * Exports a template collection back to HTML with block/brick comment delimiters.
 * Produces output compatible with htmlUploadParser.ts for round-trip editing.
 *
 * Output format:
 *   {boilerplateStart}
 *   <!-- BLOCK:block_type -->
 *   ... block HTML ...
 *   <!-- /BLOCK:block_type -->
 *   {boilerplateEnd}
 *
 * For blocks with bricks:
 *   <!-- BLOCK:community | has_bricks=true -->
 *   ... block wrapper ({{bricks}} replaced with brick comments) ...
 *   <!-- /BLOCK:community -->
 */

import { supabase } from '@/lib/supabase';

const DEFAULT_BOILERPLATE_START = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Newsletter</title>
</head>
<body>`;

const DEFAULT_BOILERPLATE_END = `</body>
</html>`;

/**
 * Export a template collection as an HTML file with comment delimiters
 */
export async function exportTemplateAsHtml(
  collectionId: string,
  variantKey: string = 'html_template'
): Promise<string> {
  // 1. Fetch collection metadata
  const { data: collection, error: collError } = await supabase
    .from('newsletters_template_collections')
    .select('metadata')
    .eq('id', collectionId)
    .single();

  if (collError) throw new Error(`Failed to load collection: ${collError.message}`);

  const metadata = collection?.metadata || {};
  const boilerplateStart = metadata.boilerplateStart || DEFAULT_BOILERPLATE_START;
  const boilerplateEnd = metadata.boilerplateEnd || DEFAULT_BOILERPLATE_END;

  // 2. Fetch block defs from the templates module.
  // variantKey selects which column to read for the body:
  //   'html_template' / default       → templates_block_defs.html
  //   'rich_text_template' / 'substack' / 'beehiiv'
  //                                   → templates_block_defs.rich_text_template
  const { data: blocks, error: blocksError } = await supabase
    .from('templates_block_defs')
    .select('id, key, name, html, rich_text_template, has_bricks')
    .eq('library_id', collectionId)
    .order('key');

  if (blocksError) throw new Error(`Failed to load blocks: ${blocksError.message}`);

  // 3. Fetch brick defs (parented by block_def_id). Join through to filter
  // by library via PostgREST inner-embed.
  const { data: bricks, error: bricksError } = await supabase
    .from('templates_brick_defs')
    .select('id, block_def_id, key, name, html, rich_text_template, sort_order, templates_block_defs!inner(library_id)')
    .eq('templates_block_defs.library_id', collectionId)
    .order('sort_order');

  if (bricksError) throw new Error(`Failed to load bricks: ${bricksError.message}`);

  const isRichText = variantKey === 'rich_text_template' || variantKey === 'substack' || variantKey === 'beehiiv';
  const pickBody = (html: string | null, richText: string | null): string =>
    (isRichText ? (richText ?? html) : html) ?? '';

  // Group bricks by block_def_id.
  const bricksByBlock = new Map<string, typeof bricks>();
  for (const brick of bricks || []) {
    const blockId = brick.block_def_id;
    if (blockId) {
      if (!bricksByBlock.has(blockId)) {
        bricksByBlock.set(blockId, []);
      }
      bricksByBlock.get(blockId)!.push(brick);
    }
  }

  // 4. Reassemble HTML
  const parts: string[] = [boilerplateStart];

  for (const block of blocks || []) {
    const hasBricks = !!block.has_bricks;
    const attrs = hasBricks ? ' | has_bricks=true' : '';
    const openTag = `<!-- BLOCK:${block.key}${attrs} -->`;
    const closeTag = `<!-- /BLOCK:${block.key} -->`;

    let blockHtml = pickBody(block.html, block.rich_text_template);

    // For blocks with bricks, replace {{bricks}} with brick comment-delimited HTML
    if (hasBricks) {
      const blockBricks = bricksByBlock.get(block.id) || [];
      const bricksHtml = blockBricks
        .map(brick => `<!-- BRICK:${brick.key} -->\n${pickBody(brick.html, brick.rich_text_template)}\n<!-- /BRICK:${brick.key} -->`)
        .join('\n');

      blockHtml = blockHtml.replace('{{bricks}}', bricksHtml);
    }

    parts.push(openTag);
    parts.push(blockHtml);
    parts.push(closeTag);
  }

  parts.push(boilerplateEnd);

  return parts.join('\n');
}

/**
 * Trigger a browser download of the exported HTML
 */
export function downloadTemplateHtml(html: string, slug: string): void {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}-template.html`;
  a.click();
  URL.revokeObjectURL(url);
}
