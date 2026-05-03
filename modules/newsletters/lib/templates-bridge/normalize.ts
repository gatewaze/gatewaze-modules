/**
 * Pure normalizers: shape a templates_block_defs row OR a legacy
 * newsletters_block_templates row into the bridge's read-side type.
 *
 * Handles the structural difference where the legacy table stores
 * { html_template, rich_text_template, schema } inside a `content` jsonb,
 * vs the new table where these are top-level columns.
 */

import type { NewsletterBlockDef, NewsletterBrickDef } from './types.js';

// ---------------------------------------------------------------------------
// Block defs
// ---------------------------------------------------------------------------

interface TemplatesBlockDefRow {
  id: string;
  library_id: string;
  key: string;
  name: string;
  description: string | null;
  schema: unknown;
  html: string | null;
  rich_text_template: string | null;
  has_bricks: boolean;
}

export function normalizeFromTemplatesBlockDef(row: TemplatesBlockDefRow): NewsletterBlockDef {
  return {
    id: row.id,
    key: row.key,
    library_id: row.library_id,
    name: row.name,
    description: row.description,
    schema: isPlainObject(row.schema) ? row.schema : {},
    html: row.html ?? '',
    rich_text_template: row.rich_text_template,
    has_bricks: row.has_bricks ?? false,
    source: 'templates_block_defs',
  };
}

interface LegacyBlockTemplateRow {
  id: string;
  collection_id: string | null;
  block_type: string;
  name: string;
  description: string | null;
  content: unknown;
  variant_key: string;
}

/**
 * Group legacy rows by (collection_id, block_type) and produce a single
 * normalized def per group. Picks the html_template variant as the
 * canonical row; merges rich-text variants into rich_text_template.
 *
 * Throws if the input lacks an `html_template` row for any (collection,
 * block_type) group — that indicates a legacy schema invariant has been
 * violated (the editor requires an html_template to render).
 */
export function normalizeLegacyBlockTemplates(rows: LegacyBlockTemplateRow[]): NewsletterBlockDef[] {
  const grouped = new Map<string, LegacyBlockTemplateRow[]>();
  for (const row of rows) {
    const key = `${row.collection_id ?? 'null'}::${row.block_type}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  const out: NewsletterBlockDef[] = [];
  for (const list of grouped.values()) {
    const htmlRow = list.find((r) => r.variant_key === 'html_template');
    if (!htmlRow) continue; // skip rows that have only rich-text variants — editor can't render
    const richRow = list
      .filter((r) => r.variant_key !== 'html_template')
      .sort((a, b) => a.variant_key.localeCompare(b.variant_key))[0];
    out.push({
      id: htmlRow.id,
      key: htmlRow.block_type,
      library_id: htmlRow.collection_id ?? '',
      name: htmlRow.name,
      description: htmlRow.description,
      schema: pickContentField(htmlRow.content, 'schema', {}) as Record<string, unknown>,
      html: pickContentField(htmlRow.content, 'html_template', pickContentField(htmlRow.content, 'template', '')) as string,
      rich_text_template: richRow ? (pickContentField(richRow.content, 'template', null) as string | null) : null,
      has_bricks: pickContentField(htmlRow.content, 'has_bricks', false) === true,
      source: 'legacy',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brick defs
// ---------------------------------------------------------------------------

interface TemplatesBrickDefRow {
  id: string;
  block_def_id: string;
  key: string;
  name: string;
  schema: unknown;
  html: string | null;
  rich_text_template: string | null;
  sort_order: number;
}

export function normalizeFromTemplatesBrickDef(row: TemplatesBrickDefRow): NewsletterBrickDef {
  return {
    id: row.id,
    key: row.key,
    block_def_id: row.block_def_id,
    name: row.name,
    schema: isPlainObject(row.schema) ? row.schema : {},
    html: row.html ?? '',
    rich_text_template: row.rich_text_template,
    sort_order: row.sort_order ?? 0,
    source: 'templates_brick_defs',
  };
}

interface LegacyBrickTemplateRow {
  id: string;
  block_template_id: string | null;
  brick_type: string;
  name: string;
  content: unknown;
  variant_key: string;
  sort_order: number;
}

export function normalizeLegacyBrickTemplates(rows: LegacyBrickTemplateRow[]): NewsletterBrickDef[] {
  const grouped = new Map<string, LegacyBrickTemplateRow[]>();
  for (const row of rows) {
    const key = `${row.block_template_id ?? 'null'}::${row.brick_type}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  const out: NewsletterBrickDef[] = [];
  for (const list of grouped.values()) {
    const htmlRow = list.find((r) => r.variant_key === 'html_template');
    if (!htmlRow || !htmlRow.block_template_id) continue;
    const richRow = list
      .filter((r) => r.variant_key !== 'html_template')
      .sort((a, b) => a.variant_key.localeCompare(b.variant_key))[0];
    out.push({
      id: htmlRow.id,
      key: htmlRow.brick_type,
      block_def_id: htmlRow.block_template_id,
      name: htmlRow.name,
      schema: pickContentField(htmlRow.content, 'schema', {}) as Record<string, unknown>,
      html: pickContentField(htmlRow.content, 'html_template', pickContentField(htmlRow.content, 'template', '')) as string,
      rich_text_template: richRow ? (pickContentField(richRow.content, 'template', null) as string | null) : null,
      sort_order: htmlRow.sort_order,
      source: 'legacy',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pickContentField(content: unknown, field: string, fallback: unknown): unknown {
  if (!isPlainObject(content)) return fallback;
  const v = content[field];
  if (v === undefined || v === null) return fallback;
  return v;
}
