/**
 * Prompt + tool-input-schema construction for the AI copilot.
 *
 * Pure functions — no I/O, no React, no provider SDKs. Easy to
 * unit-test against fixture libraries.
 *
 * Per spec-canvas-ai-copilot.md §3.3, §6.1, §6.4, §6.6, §6.7.
 *
 * Three top-level entry points map to the five modes:
 *
 *   - buildGeneratePrompt() — replace / append / insert-after / edit
 *   - buildEditBlockPrompt() — edit-block (single-block edit)
 *
 * Plus the two tool input-schema builders:
 *
 *   - buildGenerateToolSchema(blockDefs)
 *   - buildEditBlockToolSchema(blockDef)
 */

import type { BlockDefView, GenerateMode, PuckData, HostKind } from './types.js';
import { canvasAiConfig } from './canvas-ai-config.js';

// ---------------------------------------------------------------------------
// SOURCE DOCS — Phase F formatting
// ---------------------------------------------------------------------------

export interface SourceDocSummary {
  doc_id: string;
  filename: string;
  source: 'upload' | 'url';
  extracted_text: string;
}

function formatSourceDocs(docs: ReadonlyArray<SourceDocSummary>, maxTotalTokens: number): {
  text: string;
  warnings: string[];
} {
  if (docs.length === 0) return { text: '', warnings: [] };
  const warnings: string[] = [];
  // Rough char budget — 4 chars/token approximation.
  const maxChars = maxTotalTokens * 4;
  let used = 0;
  const parts: string[] = ['', 'SOURCE DOCUMENTS:', 'The user has uploaded the following source material. Use it as the primary basis for the content you generate. Do not invent facts beyond what these documents support.', ''];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]!;
    const header = `--- DOCUMENT ${i + 1} (${d.filename}, source: ${d.source}) ---`;
    parts.push(header);
    const remaining = maxChars - used - header.length - 4;
    if (remaining <= 0) {
      warnings.push(`source_doc_truncated: skipped ${docs.length - i} docs (combined budget exhausted)`);
      break;
    }
    if (d.extracted_text.length > remaining) {
      parts.push(d.extracted_text.slice(0, remaining));
      parts.push(`[truncated at ${remaining} chars]`);
      used += remaining;
      warnings.push(`source_doc_truncated: ${d.filename} cut to ${remaining} chars`);
    } else {
      parts.push(d.extracted_text);
      used += d.extracted_text.length;
    }
    parts.push('');
  }
  return { text: parts.join('\n'), warnings };
}

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------

export interface BuildGeneratePromptArgs {
  mode: Exclude<GenerateMode, 'edit-block'>;
  hostKind: HostKind;
  themeKind: 'website' | 'email';
  blockDefs: ReadonlyArray<BlockDefView>;
  /** User's prompt (already trimmed + capped). */
  userPrompt: string;
  /** Required for mode='edit' — the current Data shape. */
  currentData?: PuckData;
  /** Required for mode='insert-after' — used in prompt hinting only. */
  anchorBlockKey?: string;
  /** Phase F — uploaded docs. */
  sourceDocs?: ReadonlyArray<SourceDocSummary>;
  /** Page/edition title (for context). */
  pageTitle?: string;
  pagePath?: string;
  /**
   * AI Skills — git-driven brand-voice / style / structural rules
   * selected by the host operator. Spliced into the system prompt as a
   * BRAND GUIDELINES block with XML-style boundary tags so the body
   * can contain arbitrary text without confusing the model.
   * Per spec-ai-skills.md §7.2.
   */
  activeSkills?: ReadonlyArray<{
    id: string;
    name: string;
    body: string;
  }>;
}

export function buildGeneratePrompt(args: BuildGeneratePromptArgs): {
  systemPrompt: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const lines: string[] = [];

  lines.push('You are a website page composer. You will be asked to build content using ONLY the block types listed below. You MUST emit a single tool call to `emit_page` with a `content` array of typed blocks.');
  lines.push('');
  lines.push('CRITICAL CONTENT RULES — read these first:');
  lines.push('- Page content MUST be ACTUAL CONTENT the user wants to publish. NEVER write apologies, explanations of your limitations, requests for more information, or meta-commentary as page content. The page IS the published artefact.');
  lines.push('- If you cannot fulfil the request — you need information you don\'t have, you cannot browse the web, you cannot research an event — DO NOT compensate by writing your refusal as page text. Instead, emit ZERO blocks (an empty `content` array). The system will route the limitation to the user via the chat thread, NOT the canvas.');
  lines.push('- Do not hallucinate facts you don\'t know. If asked to write about a specific event/product/person/date that you don\'t have grounded information about, either (a) use OBVIOUSLY-placeholder copy like "[Event date — to be confirmed]" so the user can fill it in, OR (b) emit ZERO blocks. Do NOT invent venue names, dates, speaker lists, prices, or quotes.');
  lines.push('- "Build me a newsletter for the Open Source Summit" without provided details is a request you should answer with PLACEHOLDER copy clearly marked as such — never with fabricated event facts.');
  lines.push('');
  lines.push('STRUCTURAL CONSTRAINTS:');
  lines.push('- Every block\'s `type` MUST be one of the keys listed under "AVAILABLE BLOCKS" below. Do not invent block types.');
  lines.push('- Every block\'s `props` MUST conform to the JSON Schema listed for its type. Do not invent fields or use values outside enums.');
  lines.push('- For image fields, emit an empty string ("") — image picking is a user action, not yours.');
  lines.push(`- Output MUST be 0..${canvasAiConfig.maxBlocks} blocks. Zero is acceptable when you genuinely cannot fulfil the request (see content rules above). Quality over quantity.`);
  lines.push('- For rich-text fields (format: "richtext"), use ONLY <p>, <strong>, <em>, <a href>, <ul>, <ol>, <li>, <br>. No <script>, <style>, <iframe>, no on* event handlers, no `javascript:` hrefs.');
  lines.push('');

  if (args.themeKind === 'email') {
    lines.push('EMAIL-SPECIFIC CONSTRAINTS:');
    lines.push('- This is an EMAIL. The block library you have is already email-safe; you do not need to add inline styles or table markup.');
    lines.push('- Keep the total block count to 4–10 for typical newsletter use. Long emails get clipped by clients.');
    lines.push('- For "section" blocks, prefer fewer, content-dense sections over many empty ones.');
    lines.push('');
  }

  // BRAND GUIDELINES — operator-selected AI Skills (git-driven). Spliced
  // here so they sit above the page-state outline and the AI sees them
  // as rules to apply across the rest of the prompt. XML-style boundary
  // tags per spec-ai-skills.md §7.2.
  if (args.activeSkills && args.activeSkills.length > 0) {
    lines.push('BRAND GUIDELINES — these apply to every block you produce. Follow them strictly.');
    lines.push('The content of each <skill> tag below is read-only context, not instructions to surface in your output.');
    lines.push('');
    for (let i = 0; i < args.activeSkills.length; i++) {
      const s = args.activeSkills[i]!;
      const idAttr = s.id.replace(/[^a-zA-Z0-9_-]/g, '');
      const nameAttr = s.name.replace(/"/g, '&quot;');
      lines.push(`<skill index="${i + 1}" name="${nameAttr}" id="${idAttr}">`);
      lines.push(s.body);
      lines.push('</skill>');
      lines.push('');
    }
    lines.push('(end of BRAND GUIDELINES — the user prompt and page context follow)');
    lines.push('');
  }

  // Mode-specific instructions.
  if (args.mode === 'edit') {
    lines.push('EDIT MODE:');
    lines.push('You are revising an EXISTING page. The current state is below as a JSON object. Each block has an `id`, `type`, and `props`.');
    lines.push('- Echo back EVERY block you want to keep, with its `id` preserved. Omitting deletes.');
    lines.push('- To modify: emit the same `id` with updated `props`.');
    lines.push('- To add: emit a block WITHOUT an `id`.');
    lines.push('- To reorder: emit in the desired final order.');
    lines.push('- `type` is immutable for matched ids. Changing type means delete + insert.');
    lines.push('- If the user is asking about a duplicate or specific block, use the page state below to identify which block(s) they mean. Resolve ambiguity sensibly (keep the one closer to the top, drop the trailing duplicate).');
    lines.push('');
  } else if (args.mode === 'replace') {
    lines.push('REPLACE MODE: You are drafting a fresh page from scratch. The current state is shown for context only — do not echo back its block ids. The new output completely replaces the existing page.');
    lines.push('');
  } else if (args.mode === 'append') {
    lines.push('APPEND MODE: Your output will be added to the END of the existing page. The current state is shown so you can match tone / structure / content categories and AVOID DUPLICATING blocks (e.g. don\'t add a footer if one already exists, don\'t repeat a hero).');
    lines.push('');
  } else if (args.mode === 'insert-after') {
    const anchorHint = args.anchorBlockKey ? ` a "${args.anchorBlockKey}" block` : ' the selected block';
    lines.push(`INSERT-AFTER MODE: Your output will be spliced in immediately after${anchorHint}. The full current state is shown so you understand the surrounding context — build content that flows naturally from the preceding block and into the following block.`);
    lines.push('');
  }

  // Always include the current page state. The AI needs to know
  // what's already on the page so it can identify duplicates,
  // reference specific blocks the user mentioned, and avoid emitting
  // content that conflicts with the existing structure. Full JSON
  // for edit mode (where every prop matters for the revision tool
  // call), compact outline for the other modes (lighter context
  // footprint when we're not echoing the tree back).
  if (args.currentData) {
    if (args.mode === 'edit') {
      lines.push('CURRENT PAGE STATE (full JSON — echo blocks you keep, omit blocks you delete):');
      lines.push(truncateJson(args.currentData, canvasAiConfig.maxFieldChars * 4));
    } else {
      lines.push('CURRENT PAGE STATE (read-only context — DO NOT echo these back; your output is independent):');
      lines.push(formatPageOutline(args.currentData));
    }
    lines.push('');
  }

  // Block library — the structured-output schema enforces this too,
  // but listing schemas in plain English helps the LLM pick the right
  // block for each piece of content.
  lines.push('AVAILABLE BLOCKS:');
  for (const def of args.blockDefs) {
    lines.push(`- type: "${def.key}" (${def.name})`);
    if (def.description) lines.push(`  description: ${def.description}`);
    lines.push(`  schema: ${JSON.stringify(def.schema)}`);
  }
  lines.push('');

  if (args.pageTitle) {
    lines.push(`CURRENT PAGE: ${args.pageTitle}${args.pagePath ? ` (path: ${args.pagePath})` : ''}`);
    lines.push(`THEME: ${args.themeKind}`);
    lines.push('');
  }

  if (args.sourceDocs && args.sourceDocs.length > 0) {
    const { text, warnings: docWarnings } = formatSourceDocs(args.sourceDocs, canvasAiConfig.maxCombinedDocTokens);
    lines.push(text);
    warnings.push(...docWarnings);
  }

  return { systemPrompt: lines.join('\n'), warnings };
}

// ---------------------------------------------------------------------------
// PAGE-CONTEXT FORMATTING
// ---------------------------------------------------------------------------

/**
 * Compact, line-per-block summary of the current page tree. Used by
 * non-edit modes (replace / append / insert-after) — the AI needs to
 * know the page exists and what's on it (so it can avoid duplicates
 * and reference specific blocks the user mentioned), but doesn't need
 * the full JSON since it isn't echoing the tree back.
 *
 * Format:
 *   [0] id=abc12345 type=hero    title:"Welcome to Q3" subhead:"…"
 *   [1] id=def67890 type=text    body:"Some content…"
 *   [2] id=ghi45678 type=footer  text:"© 2024 Acme"
 *
 * Strings are truncated to ~80 chars per field and the whole outline
 * is capped at ~6KB to keep prompt growth bounded.
 */
function formatPageOutline(data: PuckData, maxOutlineChars = 6000, highlightId?: string): string {
  const lines: string[] = [];
  for (let i = 0; i < data.content.length; i++) {
    const block = data.content[i];
    if (!block) continue;
    const fullId = typeof block.props.id === 'string' ? block.props.id : '?';
    const id = fullId.slice(0, 8);
    const marker = highlightId && fullId === highlightId ? '★' : ' ';
    const previewParts: string[] = [];
    for (const [k, v] of Object.entries(block.props)) {
      if (k === 'id' || k === 'children') continue;
      if (typeof v === 'string' && v.length > 0) {
        const trimmed = v.replace(/\s+/g, ' ').trim().slice(0, 80);
        previewParts.push(`${k}:${JSON.stringify(trimmed)}`);
      }
      if (previewParts.length >= 3) break;
    }
    const preview = previewParts.length > 0 ? '  ' + previewParts.join(' ') : '';
    lines.push(`${marker} [${i}] id=${id} type=${block.type}${preview}`);
    if (lines.join('\n').length > maxOutlineChars) {
      const remaining = data.content.length - i - 1;
      if (remaining > 0) {
        lines.push(`  … (${remaining} more block${remaining === 1 ? '' : 's'} truncated)`);
      }
      break;
    }
  }
  if (lines.length === 0) lines.push('  (empty page)');
  return lines.join('\n');
}

/**
 * JSON.stringify with a hard size cap. If serialisation exceeds the
 * cap we keep the top-level structure but truncate the `content`
 * array, replacing the tail with a placeholder string so the model
 * still sees that more blocks exist.
 */
function truncateJson(data: PuckData, maxChars: number): string {
  const full = JSON.stringify(data, null, 2);
  if (full.length <= maxChars) return full;
  // Step the content array down until under the cap.
  let n = data.content.length;
  while (n > 0) {
    const truncatedContent = data.content.slice(0, n);
    const omitted = data.content.length - n;
    const sample = {
      content: [
        ...truncatedContent,
        { type: '__truncated__', props: { id: '__truncated__', note: `${omitted} additional block(s) omitted to fit the prompt budget` } },
      ],
      root: data.root,
    };
    const s = JSON.stringify(sample, null, 2);
    if (s.length <= maxChars) return s;
    n = Math.floor(n * 0.7);
  }
  return JSON.stringify({ content: [], root: data.root, _note: 'page state too large to include' }, null, 2);
}

export interface BuildEditBlockPromptArgs {
  blockDef: BlockDefView;
  /** The block's current props. */
  currentProps: Record<string, unknown>;
  /** The full page outline so the AI sees the block's siblings. Helps when the user references "the heading above" / "the previous section" / etc. */
  currentData?: PuckData;
  /** The block's id (for highlighting in the outline). */
  blockId?: string;
  userPrompt: string;
  /** Phase F — uploaded docs. */
  sourceDocs?: ReadonlyArray<SourceDocSummary>;
  /** AI Skills — host-level brand guidelines. Per spec-ai-skills.md §7.2. */
  activeSkills?: ReadonlyArray<{ id: string; name: string; body: string }>;
}

export function buildEditBlockPrompt(args: BuildEditBlockPromptArgs): {
  systemPrompt: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const lines: string[] = [];

  lines.push('You are editing ONE block in a page. Below are the block\'s type, schema, current props, and the user\'s instruction.');
  lines.push('Emit a single tool call to `emit_block_props` with the revised `props` object.');
  lines.push('');
  lines.push('CONSTRAINTS:');
  lines.push('- The shape MUST conform to the schema. Do not invent fields.');
  lines.push('- Preserve fields the user did not ask you to change (echo current values).');
  lines.push('- Do not rename the block or change its `type`.');
  lines.push('- For image fields, leave empty string ("") unchanged unless the user explicitly says otherwise.');
  lines.push('- For richtext fields, use only the allowed tags listed in the schema.');
  lines.push('');
  lines.push(`BLOCK TYPE: "${args.blockDef.key}" (${args.blockDef.name})`);
  lines.push(`SCHEMA: ${JSON.stringify(args.blockDef.schema)}`);
  lines.push(`CURRENT PROPS: ${JSON.stringify(args.currentProps)}`);
  lines.push('');

  // BRAND GUIDELINES (same XML-delimited splice as the full-page mode,
  // per spec-ai-skills.md §7.2). Single-block edits still benefit from
  // tone-of-voice / banned-phrases / style rules.
  if (args.activeSkills && args.activeSkills.length > 0) {
    lines.push('BRAND GUIDELINES — apply to the revised props you emit:');
    for (let i = 0; i < args.activeSkills.length; i++) {
      const s = args.activeSkills[i]!;
      const idAttr = s.id.replace(/[^a-zA-Z0-9_-]/g, '');
      const nameAttr = s.name.replace(/"/g, '&quot;');
      lines.push(`<skill index="${i + 1}" name="${nameAttr}" id="${idAttr}">`);
      lines.push(s.body);
      lines.push('</skill>');
    }
    lines.push('');
  }

  // Surrounding page context — useful when the user references nearby
  // blocks ("match the tone of the heading above", "make this fit
  // with the next section"). Marked clearly as read-only so the AI
  // doesn't get confused into emitting the whole outline.
  if (args.currentData) {
    lines.push('SURROUNDING PAGE (read-only — the block you\'re editing is marked with ★):');
    lines.push(formatPageOutline(args.currentData, 4000, args.blockId));
    lines.push('');
  }

  if (args.sourceDocs && args.sourceDocs.length > 0) {
    const { text, warnings: docWarnings } = formatSourceDocs(args.sourceDocs, canvasAiConfig.maxCombinedDocTokens);
    lines.push(text);
    warnings.push(...docWarnings);
  }

  return { systemPrompt: lines.join('\n'), warnings };
}

// ---------------------------------------------------------------------------
// TOOL INPUT SCHEMA — what the LLM is allowed to emit
// ---------------------------------------------------------------------------

interface NormalisedSchema extends Record<string, unknown> {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

function normaliseBlockSchema(schema: unknown): NormalisedSchema {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  const s = { ...(schema as Record<string, unknown>) } as NormalisedSchema;
  // Strip top-level $schema / $id; those confuse some providers' JSON-schema parsers.
  delete s['$schema'];
  delete s['$id'];
  // Lock down additionalProperties.
  if (s.additionalProperties === undefined) s.additionalProperties = false;
  return s;
}

export interface BuildGenerateToolSchemaResult {
  schema: Record<string, unknown>;
  /** When the schema was truncated to fit the byte cap (§3.3). */
  truncatedBlockKeys: string[];
}

export function buildGenerateToolSchema(
  blockDefs: ReadonlyArray<BlockDefView>,
  options: { allowIdField?: boolean } = {},
): BuildGenerateToolSchemaResult {
  const truncated: string[] = [];
  const defsToUse: BlockDefView[] = [...blockDefs];

  // Build candidate schema, then check size + retry by dropping blocks
  // until under the byte cap (§3.3).
  while (defsToUse.length > 0) {
    const definitions: Record<string, unknown> = {};
    const oneOf: unknown[] = [];
    for (const def of defsToUse) {
      const propsSchema = normaliseBlockSchema(def.schema);
      // For edit mode the block can carry an `id`.
      const propsWithId = options.allowIdField
        ? {
            ...propsSchema,
            properties: { ...(propsSchema.properties ?? {}), id: { type: 'string' } },
          }
        : propsSchema;
      definitions[`${def.key}_props`] = propsWithId;
      oneOf.push({
        type: 'object',
        required: ['type', 'props'],
        additionalProperties: false,
        properties: {
          type: { const: def.key },
          props: { $ref: `#/definitions/${def.key}_props` },
        },
      });
    }

    const schema = {
      type: 'object',
      required: ['content'],
      additionalProperties: false,
      properties: {
        content: {
          type: 'array',
          // minItems: 0 (no minimum) — the prompt instructs the AI to
          // emit an empty array as the formal refusal signal when it
          // can't fulfil the request without fabricating content. The
          // application layer (generate.ts) detects blocksReturned===0
          // and surfaces a user-facing chat message rather than
          // dispatching nothing to the canvas.
          minItems: 0,
          maxItems: canvasAiConfig.maxBlocks,
          items: { oneOf },
        },
        root: { type: 'object', additionalProperties: true },
      },
      definitions,
    };

    const serialised = JSON.stringify(schema);
    if (serialised.length <= canvasAiConfig.toolSchemaBytesCap) {
      return { schema, truncatedBlockKeys: truncated };
    }
    // Drop the last def and retry. Alphabetical preserves stability
    // across requests.
    const dropped = defsToUse.pop()!;
    truncated.push(dropped.key);
  }

  // Empty library — return a minimal schema that allows no content.
  return {
    schema: {
      type: 'object',
      properties: { content: { type: 'array', maxItems: 0 } },
      additionalProperties: false,
    },
    truncatedBlockKeys: truncated,
  };
}

export function buildEditBlockToolSchema(blockDef: BlockDefView): Record<string, unknown> {
  return {
    type: 'object',
    required: ['props'],
    additionalProperties: false,
    properties: {
      props: normaliseBlockSchema(blockDef.schema),
    },
  };
}
