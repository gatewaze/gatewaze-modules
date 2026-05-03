/**
 * AI Section Mapper
 * Uses Claude API to map Google Doc sections to newsletter block templates.
 */

import type { DocSection } from './doc-fetcher.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** templates_block_defs row shape (block_type aliased from `key`). */
export interface BlockTemplate {
  id: string;
  block_type: string;
  name: string;
  description?: string;
  has_bricks: boolean;
  schema: Record<string, unknown>;
  sort_order: number;
}

/** templates_brick_defs row shape (brick_type aliased from `key`). */
export interface BrickTemplate {
  id: string;
  brick_type: string;
  name: string;
  schema: Record<string, unknown>;
  /** FK to templates_block_defs.id (parent block_def). */
  block_def_id: string;
  sort_order: number;
}

export interface AIMappingResult {
  blocks: Array<{
    block_type: string;
    sort_order: number;
    content: Record<string, unknown>;
    bricks?: Array<{
      brick_type: string;
      sort_order: number;
      content: Record<string, unknown>;
    }>;
  }>;
  unmapped: Array<{
    heading: string;
    reason: string;
  }>;
  extracted_date?: string;
}

// Static block types that are created with defaults, not AI-mapped
const STATIC_BLOCK_TYPES = new Set(['header', 'footer', 'toc', 'view_online']);

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(
  sections: DocSection[],
  blockTemplates: BlockTemplate[],
  brickTemplates: BrickTemplate[],
): string {
  // Group brick templates by parent block
  const bricksByBlock = new Map<string, BrickTemplate[]>();
  for (const brick of brickTemplates) {
    const existing = bricksByBlock.get(brick.block_def_id) || [];
    existing.push(brick);
    bricksByBlock.set(brick.block_def_id, existing);
  }

  // Build template descriptions
  const templateDescriptions = blockTemplates
    .filter((bt) => !STATIC_BLOCK_TYPES.has(bt.block_type))
    .map((bt) => {
      let desc = `- Block type: "${bt.block_type}"\n`;
      desc += `  Name: "${bt.name}"\n`;
      if (bt.description) desc += `  Description: ${bt.description}\n`;
      desc += `  Has bricks: ${bt.has_bricks}\n`;
      desc += `  Schema: ${JSON.stringify(bt.schema, null, 2)}\n`;

      const bricks = bricksByBlock.get(bt.id);
      if (bricks && bricks.length > 0) {
        desc += `  Brick types:\n`;
        for (const brick of bricks) {
          desc += `    - "${brick.brick_type}" (${brick.name}): ${JSON.stringify(brick.schema)}\n`;
        }
      }

      return desc;
    })
    .join('\n');

  // Serialize the document sections
  const docContent = serializeSections(sections, 0);

  return `You are mapping a Google Doc newsletter to a template system with specific block types.

AVAILABLE BLOCK TEMPLATES:
${templateDescriptions}

STATIC BLOCKS (will be auto-created with defaults, do NOT map content to these):
${[...STATIC_BLOCK_TYPES].join(', ')}

DOCUMENT CONTENT:
${docContent}

INSTRUCTIONS:
1. Analyze each section of the document and map it to the most appropriate block template.
2. For blocks with bricks (has_bricks=true), create individual brick entries for each item in the section.
3. Extract content into the exact schema fields defined for each block/brick.
4. Preserve all links — include them in the content fields where the schema expects them. For "sources" arrays, create objects with "label" and "url" fields.
5. For fields with format "html", convert text formatting to simple HTML: <strong> for bold, <em> for italic, <a href="..."> for links, <p> for paragraphs.
6. Assign sort_order values starting from 1, in the order sections appear in the document.
7. If a section doesn't match any block type, include it in "unmapped" with a reason.
8. If you can detect an edition date from the content (e.g., "March 10, 2026"), include it as extracted_date in YYYY-MM-DD format.

Return ONLY valid JSON matching this exact structure:
{
  "blocks": [
    {
      "block_type": "string",
      "sort_order": number,
      "content": { ... matches block schema ... },
      "bricks": [
        {
          "brick_type": "string",
          "sort_order": number,
          "content": { ... matches brick schema ... }
        }
      ]
    }
  ],
  "unmapped": [
    { "heading": "string", "reason": "string" }
  ],
  "extracted_date": "YYYY-MM-DD or null"
}`;
}

function serializeSections(sections: DocSection[], depth: number): string {
  const indent = '  '.repeat(depth);
  let result = '';

  for (const section of sections) {
    result += `${indent}## ${'#'.repeat(section.headingLevel)} ${section.heading}\n`;

    for (const para of section.paragraphs) {
      if (para.images && para.images.length > 0) {
        result += `${indent}  [IMAGE: ${para.images.map((i) => i.objectId).join(', ')}]\n`;
      }

      let text = para.text;
      // Annotate links inline
      if (para.links.length > 0) {
        for (const link of para.links) {
          text = text.replace(link.text, `[${link.text}](${link.url})`);
        }
      }

      if (para.listType) {
        result += `${indent}  ${para.listType === 'bullet' ? '-' : '1.'} ${text}\n`;
      } else {
        result += `${indent}  ${text}\n`;
      }
    }

    if (section.subsections.length > 0) {
      result += serializeSections(section.subsections, depth + 1);
    }

    result += '\n';
  }

  return result;
}

// ---------------------------------------------------------------------------
// AI call
// ---------------------------------------------------------------------------

export async function mapSectionsToBlocks(
  sections: DocSection[],
  blockTemplates: BlockTemplate[],
  brickTemplates: BrickTemplate[],
): Promise<{ result: AIMappingResult; tokenUsage: { input: number; output: number } }> {
  const prompt = buildPrompt(sections, blockTemplates, brickTemplates);
  return callClaude(prompt);
}

/**
 * Map raw HTML content to blocks — used when the document can't be parsed
 * into a structured section tree (e.g., Google Docs HTML export which uses
 * CSS classes instead of semantic heading tags).
 */
export async function mapHtmlToBlocks(
  html: string,
  blockTemplates: BlockTemplate[],
  brickTemplates: BrickTemplate[],
): Promise<{ result: AIMappingResult; tokenUsage: { input: number; output: number } }> {
  const bricksByBlock = new Map<string, BrickTemplate[]>();
  for (const brick of brickTemplates) {
    const existing = bricksByBlock.get(brick.block_def_id) || [];
    existing.push(brick);
    bricksByBlock.set(brick.block_def_id, existing);
  }

  const templateDescriptions = blockTemplates
    .filter((bt) => !STATIC_BLOCK_TYPES.has(bt.block_type))
    .map((bt) => {
      let desc = `- Block type: "${bt.block_type}"\n`;
      desc += `  Name: "${bt.name}"\n`;
      if (bt.description) desc += `  Description: ${bt.description}\n`;
      desc += `  Has bricks: ${bt.has_bricks}\n`;
      desc += `  Schema: ${JSON.stringify(bt.schema, null, 2)}\n`;
      const bricks = bricksByBlock.get(bt.id);
      if (bricks && bricks.length > 0) {
        desc += `  Brick types:\n`;
        for (const brick of bricks) {
          desc += `    - "${brick.brick_type}" (${brick.name}): ${JSON.stringify(brick.schema)}\n`;
        }
      }
      return desc;
    })
    .join('\n');

  // Strip <style> and <head> to reduce token usage, keep body content
  let bodyContent = html;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) bodyContent = bodyMatch[1];
  // Strip style tags
  bodyContent = bodyContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  const prompt = `You are mapping a Google Doc newsletter (exported as HTML) to a template system with specific block types.

AVAILABLE BLOCK TEMPLATES:
${templateDescriptions}

STATIC BLOCKS (will be auto-created with defaults, do NOT map content to these):
${[...STATIC_BLOCK_TYPES].join(', ')}

DOCUMENT HTML:
${bodyContent}

INSTRUCTIONS:
1. The HTML uses CSS classes for formatting (not semantic heading tags). Identify section boundaries by looking at bold/uppercase text patterns that act as section headers (e.g., "FOUNDATION NEWS", "AI", "SECURITY", "OPEN SOURCE", etc.).
2. Map each identified section to the most appropriate block template based on name and content type.
3. For blocks with bricks (has_bricks=true), create individual brick entries for each item in the section. For example, each news item with a bold headline, description, and link(s) should be a separate brick.
4. Extract content into the exact schema fields defined for each block/brick.
5. Preserve all links — extract href URLs from <a> tags and include them in the appropriate schema fields.
6. For fields with format "html", provide clean HTML: <strong> for bold, <em> for italic, <a href="..."> for links, <p> for paragraphs.
7. For the editor's note / opening letter section, extract the full body text as HTML.
8. Assign sort_order values starting from 1, in the order sections appear in the document.
9. If a section doesn't match any block type, include it in "unmapped" with a reason.
10. If you can detect an edition date from the content, include it as extracted_date in YYYY-MM-DD format.

Return ONLY valid JSON matching this exact structure:
{
  "blocks": [
    {
      "block_type": "string",
      "sort_order": number,
      "content": { ... matches block schema ... },
      "bricks": [
        {
          "brick_type": "string",
          "sort_order": number,
          "content": { ... matches brick schema ... }
        }
      ]
    }
  ],
  "unmapped": [
    { "heading": "string", "reason": "string" }
  ],
  "extracted_date": "YYYY-MM-DD or null"
}`;

  return callClaude(prompt);
}

async function callClaude(prompt: string): Promise<{ result: AIMappingResult; tokenUsage: { input: number; output: number } }> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  const tokenUsage = {
    input: data.usage?.input_tokens || 0,
    output: data.usage?.output_tokens || 0,
  };

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI response did not contain valid JSON');
  }

  try {
    const result = JSON.parse(jsonMatch[0]) as AIMappingResult;
    if (!Array.isArray(result.blocks)) {
      throw new Error('AI response missing "blocks" array');
    }
    return { result, tokenUsage };
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`AI response contained invalid JSON: ${err.message}`);
    }
    throw err;
  }
}
