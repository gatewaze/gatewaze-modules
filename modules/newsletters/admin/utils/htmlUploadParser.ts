/**
 * HTML Template Upload Parser
 *
 * Parses a single HTML file containing block comment delimiters into
 * individual block and brick templates. Supports round-trip editing.
 *
 * Extended comment format:
 *   <!-- BLOCK:block_type | name=Display Name | description=... | has_bricks=false | sort_order=0 -->
 *   <!-- SCHEMA:{"type":"object","properties":{...}} -->
 *   ... block HTML ...
 *   <!-- /BLOCK:block_type -->
 *
 * Nested bricks within blocks:
 *   <!-- BLOCK:community | has_bricks=true | sort_order=6 -->
 *   <!-- SCHEMA:{} -->
 *   ... block wrapper with {{bricks}} placeholder ...
 *     <!-- BRICK:podcast | name=Podcast | sort_order=1 -->
 *     <!-- SCHEMA:{...} -->
 *     ... brick HTML ...
 *     <!-- /BRICK:podcast -->
 *   <!-- /BLOCK:community -->
 */

export interface ParsedBlock {
  blockType: string;
  name: string;
  description: string;
  html: string;
  richTextHtml: string | null;
  hasBricks: boolean;
  schema: Record<string, unknown>;
  bricks: ParsedBrick[];
  sortOrder: number;
}

export interface ParsedBrick {
  brickType: string;
  name: string;
  html: string;
  richTextHtml: string | null;
  schema: Record<string, unknown>;
  sortOrder: number;
}

export interface ParseResult {
  blocks: ParsedBlock[];
  boilerplateStart: string;
  boilerplateEnd: string;
  errors: string[];
}

/**
 * Convert snake_case block type to a human-readable name
 */
function typeToName(type: string): string {
  return type
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Parse key=value attributes from a block/brick comment's attribute string.
 * e.g. "name=Header | description=Static header | has_bricks=false | sort_order=0"
 */
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrString) return attrs;

  const parts = attrString.split('|').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex !== -1) {
      const key = part.substring(0, eqIndex).trim();
      const value = part.substring(eqIndex + 1).trim();
      attrs[key] = value;
    }
  }
  return attrs;
}

/**
 * Extract a <!-- SCHEMA:{...} --> JSON object from the beginning of a content string.
 * Returns the parsed schema and the remaining content with the schema comment removed.
 */
function extractSchema(content: string): { schema: Record<string, unknown>; remaining: string } {
  const schemaMatch = content.match(/^\s*<!--\s*SCHEMA:([\s\S]*?)-->/);
  if (!schemaMatch) {
    return { schema: {}, remaining: content };
  }

  let schema: Record<string, unknown> = {};
  try {
    const jsonStr = schemaMatch[1].trim();
    if (jsonStr && jsonStr !== '{}') {
      schema = JSON.parse(jsonStr);
    }
  } catch (e) {
    console.warn('Failed to parse SCHEMA JSON:', e);
  }

  const remaining = content.substring(schemaMatch[0].length);
  return { schema, remaining };
}

/**
 * Extract <!-- RICH_TEXT_TEMPLATE -->...<!-- /RICH_TEXT_TEMPLATE --> from content.
 * The actual HTML is inside an HTML comment within the tags.
 */
function extractRichTextTemplate(content: string): { richTextHtml: string | null; remaining: string } {
  const rtMatch = content.match(/<!--\s*RICH_TEXT_TEMPLATE\s*-->([\s\S]*?)<!--\s*\/RICH_TEXT_TEMPLATE\s*-->/);
  if (!rtMatch) {
    return { richTextHtml: null, remaining: content };
  }

  // The rich text is typically wrapped in HTML comments: <!-- \n<html>...\n -->
  let richText = rtMatch[1].trim();
  // Strip surrounding HTML comment markers if present
  if (richText.startsWith('<!--')) {
    richText = richText.replace(/^<!--\s*/, '').replace(/\s*-->$/, '').trim();
  }

  // Remove the entire RICH_TEXT_TEMPLATE block from the content
  const remaining = content.replace(rtMatch[0], '');
  return { richTextHtml: richText || null, remaining };
}

/**
 * Parse an HTML file with block/brick comment delimiters into templates
 */
export function parseHtmlTemplate(html: string): ParseResult {
  const errors: string[] = [];
  const blocks: ParsedBlock[] = [];

  // Match blocks with extended attributes:
  // <!-- BLOCK:type | key=value | ... -->  ...content...  <!-- /BLOCK:type -->
  const blockPattern = /<!--\s*BLOCK:(\w+)(?:\s*\|\s*(.*?))?\s*-->([\s\S]*?)<!--\s*\/BLOCK:\1\s*-->/g;

  let blockMatch;

  while ((blockMatch = blockPattern.exec(html)) !== null) {
    const blockType = blockMatch[1];
    const attrString = blockMatch[2]?.trim() || '';
    let blockContent = blockMatch[3];

    const attrs = parseAttributes(attrString);
    const hasBricks = attrs.has_bricks === 'true';
    const sortOrder = attrs.sort_order !== undefined ? parseInt(attrs.sort_order, 10) : blocks.length;
    const name = attrs.name || typeToName(blockType);
    const description = attrs.description || '';

    // Extract SCHEMA from the beginning of block content
    const { schema, remaining: afterSchema } = extractSchema(blockContent);
    blockContent = afterSchema;

    const bricks: ParsedBrick[] = [];
    if (hasBricks) {
      // Extract bricks from within the block
      const brickPattern = /<!--\s*BRICK:(\w+)(?:\s*\|\s*([^-]*?))?\s*-->([\s\S]*?)<!--\s*\/BRICK:\1\s*-->/g;
      let brickMatch;

      while ((brickMatch = brickPattern.exec(blockContent)) !== null) {
        const brickType = brickMatch[1];
        const brickAttrString = brickMatch[2]?.trim() || '';
        let brickContent = brickMatch[3];

        const brickAttrs = parseAttributes(brickAttrString);
        const brickSortOrder = brickAttrs.sort_order !== undefined ? parseInt(brickAttrs.sort_order, 10) : bricks.length;
        const brickName = brickAttrs.name || typeToName(brickType);

        // Extract SCHEMA from brick content
        const { schema: brickSchema, remaining: brickAfterSchema } = extractSchema(brickContent);
        brickContent = brickAfterSchema;

        // Extract rich text template if present
        const { richTextHtml: brickRichText, remaining: brickAfterRt } = extractRichTextTemplate(brickContent);
        brickContent = brickAfterRt;

        bricks.push({
          brickType,
          name: brickName,
          html: brickContent.trim(),
          richTextHtml: brickRichText,
          schema: brickSchema,
          sortOrder: brickSortOrder,
        });
      }

      // Replace brick region with {{bricks}} placeholder
      const firstBrickStart = blockContent.indexOf('<!-- BRICK:');
      const lastBrickEndComment = blockContent.lastIndexOf('<!-- /BRICK:');
      if (firstBrickStart !== -1 && lastBrickEndComment !== -1) {
        const lastBrickEndPos = blockContent.indexOf('-->', lastBrickEndComment) + 3;
        blockContent =
          blockContent.substring(0, firstBrickStart).trim() +
          '\n{{bricks}}\n' +
          blockContent.substring(lastBrickEndPos).trim();
      }
    }

    // Extract rich text template if present
    const { richTextHtml: blockRichText, remaining: afterRt } = extractRichTextTemplate(blockContent);
    blockContent = afterRt;

    blocks.push({
      blockType,
      name,
      description,
      html: blockContent.trim(),
      richTextHtml: blockRichText,
      hasBricks,
      schema,
      bricks,
      sortOrder,
    });
  }

  if (blocks.length === 0) {
    errors.push('No block comments found. Expected format: <!-- BLOCK:type --> ... <!-- /BLOCK:type -->');
  }

  // Extract boilerplate (everything before first block and after last block)
  let boilerplateStart = '';
  let boilerplateEnd = '';

  const firstBlockComment = html.indexOf('<!-- BLOCK:');
  const lastBlockEnd = html.lastIndexOf('<!-- /BLOCK:');
  if (firstBlockComment !== -1) {
    boilerplateStart = html.substring(0, firstBlockComment).trim();
  }
  if (lastBlockEnd !== -1) {
    const lastBlockEndPos = html.indexOf('-->', lastBlockEnd) + 3;
    // Also strip SPACER_TEMPLATE if present at the end
    let endContent = html.substring(lastBlockEndPos);
    endContent = endContent.replace(/<!--\s*SPACER:[\s\S]*?<!--\s*\/SPACER_TEMPLATE\s*-->/g, '');
    boilerplateEnd = endContent.trim();
  }

  return { blocks, boilerplateStart, boilerplateEnd, errors };
}

/**
 * Import parsed blocks into a template library via Supabase.
 *
 * Writes to the templates module's tables (templates_block_defs /
 * templates_brick_defs) — the legacy newsletters_block_templates path is
 * gone as of PR 16.b. The `collectionId` argument is the legacy collection
 * id, which migration 021 maps 1-to-1 onto a templates_libraries row id.
 *
 * variantKey semantics in the new model:
 *   - 'html_template' (default) — writes to .html and (if present)
 *     .rich_text_template, creating the row if missing.
 *   - any other value — UPDATES only the .rich_text_template column on
 *     an existing row. Will not create a row by itself; the html variant
 *     must be imported first.
 */
export async function importParsedBlocks(
  supabaseClient: any,
  collectionId: string,
  parseResult: ParseResult,
  variantKey: string = 'html_template'
): Promise<{ created: number; updated: number; errors: string[] }> {
  let created = 0;
  let updated = 0;
  const errors: string[] = [];
  const isHtmlVariant = variantKey === 'html_template';

  for (const block of parseResult.blocks) {
    try {
      const { data: existing } = await supabaseClient
        .from('templates_block_defs')
        .select('id, html, rich_text_template')
        .eq('library_id', collectionId)
        .eq('key', block.blockType)
        .maybeSingle();

      let blockDefId: string;

      if (existing) {
        const update: Record<string, unknown> = isHtmlVariant
          ? {
              name: block.name,
              description: block.description || null,
              schema: block.schema,
              html: block.html,
              rich_text_template: block.richTextHtml || existing.rich_text_template,
              has_bricks: block.hasBricks,
              updated_at: new Date().toISOString(),
            }
          : {
              rich_text_template: block.richTextHtml,
              updated_at: new Date().toISOString(),
            };
        const { error } = await supabaseClient
          .from('templates_block_defs')
          .update(update)
          .eq('id', existing.id);
        if (error) throw error;
        blockDefId = existing.id;
        updated++;
      } else if (!isHtmlVariant) {
        // Non-html variant for a block that doesn't exist yet — skip; the
        // html variant must be imported first to seed the row.
        errors.push(`Block ${block.blockType}: rich-text variant skipped (no html_template row to update)`);
        continue;
      } else {
        const { data: inserted, error } = await supabaseClient
          .from('templates_block_defs')
          .insert({
            library_id: collectionId,
            key: block.blockType,
            name: block.name,
            description: block.description || null,
            source_kind: 'static',
            schema: block.schema,
            html: block.html,
            rich_text_template: block.richTextHtml || null,
            has_bricks: block.hasBricks,
            version: 1,
            is_current: true,
          })
          .select('id')
          .single();
        if (error) throw error;
        blockDefId = inserted.id;
        created++;
      }

      // Import bricks (linked to parent block via block_def_id)
      for (const brick of block.bricks) {
        try {
          const { data: existingBrick } = await supabaseClient
            .from('templates_brick_defs')
            .select('id, html, rich_text_template')
            .eq('block_def_id', blockDefId)
            .eq('key', brick.brickType)
            .maybeSingle();

          if (existingBrick) {
            const brickUpdate: Record<string, unknown> = isHtmlVariant
              ? {
                  name: brick.name,
                  schema: brick.schema,
                  html: brick.html,
                  rich_text_template: brick.richTextHtml || existingBrick.rich_text_template,
                  sort_order: brick.sortOrder,
                  updated_at: new Date().toISOString(),
                }
              : {
                  rich_text_template: brick.richTextHtml,
                  updated_at: new Date().toISOString(),
                };
            await supabaseClient
              .from('templates_brick_defs')
              .update(brickUpdate)
              .eq('id', existingBrick.id);
          } else if (!isHtmlVariant) {
            errors.push(`Brick ${brick.brickType}: rich-text variant skipped (no html_template row to update)`);
          } else {
            await supabaseClient
              .from('templates_brick_defs')
              .insert({
                block_def_id: blockDefId,
                key: brick.brickType,
                name: brick.name,
                schema: brick.schema,
                html: brick.html,
                rich_text_template: brick.richTextHtml || null,
                sort_order: brick.sortOrder,
              });
          }
        } catch (err) {
          errors.push(`Brick ${brick.brickType}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }
    } catch (err) {
      errors.push(`Block ${block.blockType}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // Store boilerplate HTML in collection metadata for export round-trip
  if (parseResult.boilerplateStart || parseResult.boilerplateEnd) {
    try {
      const { data: collection } = await supabaseClient
        .from('newsletters_template_collections')
        .select('metadata')
        .eq('id', collectionId)
        .single();

      const existingMetadata = collection?.metadata || {};
      await supabaseClient
        .from('newsletters_template_collections')
        .update({
          metadata: {
            ...existingMetadata,
            boilerplateStart: parseResult.boilerplateStart,
            boilerplateEnd: parseResult.boilerplateEnd,
          },
        })
        .eq('id', collectionId);
    } catch (err) {
      errors.push(`Boilerplate metadata: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  return { created, updated, errors };
}
