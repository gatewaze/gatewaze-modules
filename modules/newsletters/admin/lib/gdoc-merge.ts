/**
 * Merge a Google Doc fill proposal (api/gdoc-fill-routes.ts) into an edition.
 *
 *   planGdocMerge   proposal + edition → one row per change, saying whether
 *                   the target already has content (the author then chooses
 *                   "keep current" or "use the doc")
 *   applyGdocMerge  the plan + the author's choices → the new edition state,
 *                   plus the research edit layers to write
 *
 * Research blocks are not filled through their content: the research field is
 * written only by runs. Taking the doc for a research block becomes an EDIT
 * LAYER (content.research_edits): every researched item is removed and the
 * doc's items are added, so a later run cannot overwrite the editor's choice.
 * The edit layer is written through newsletters_research_edits_write, the same
 * path as the Research panel; everything else goes through the normal save.
 */

import type { EditionBlock, NewsletterEdition, BlockTemplate } from '../utils';
import { researchBindingOf, researchOutputFormat, renderContentOf } from './research-block';
import { defaultsFor, type SchemaFieldDef } from '../../lib/schema-defaults.js';

export interface GdocProposalBlock {
  target_block_id: string | null;
  block_type: string;
  source_heading: string | null;
  content: Record<string, unknown>;
}

export interface GdocProposal {
  subject: string | null;
  preheader: string | null;
  blocks: GdocProposalBlock[];
  unmapped: Array<{ heading: string; reason: string }>;
}

export type GdocChangeKind = 'subject' | 'preheader' | 'block' | 'new_block';

export interface GdocChange {
  /** Stable id for the choice map. */
  id: string;
  kind: GdocChangeKind;
  /** Display name: the block's name, "Subject" or "Preheader". */
  label: string;
  source_heading: string | null;
  /** True when the target already has content of its own: the author must choose. */
  conflict: boolean;
  /** Short text of what is there now and what the doc would put there. */
  current_preview: string;
  incoming_preview: string;
  /** Research block: the doc's content goes into the edit layer. */
  research: boolean;
  target_block_id: string | null;
  block_type: string;
  incoming: Record<string, unknown> | string;
}

export type GdocChoice = 'doc' | 'keep';

function schemaOf(tpl: BlockTemplate | undefined | null): Record<string, SchemaFieldDef> {
  const s = (tpl as unknown as { content?: { schema?: unknown }; schema?: unknown } | null)?.content?.schema
    ?? (tpl as unknown as { schema?: unknown } | null)?.schema;
  return (s && typeof s === 'object' ? s : {}) as Record<string, SchemaFieldDef>;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.replace(/<[^>]*>/g, '').trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).every(isEmptyValue);
  return false;
}

/**
 * A block "has content" when any schema field holds something other than
 * its default (an eyebrow left at "TOP STORIES" does not count).
 */
export function blockHasContent(block: EditionBlock): boolean {
  const binding = researchBindingOf(block.block_template);
  const content = binding ? renderContentOf(block) : (block.content ?? {}) as Record<string, unknown>;
  const schema = schemaOf(block.block_template);
  const defaults = defaultsFor(schema);
  const fields = Object.keys(schema).length > 0 ? Object.keys(schema) : Object.keys(content);
  return fields.some((k) => {
    if (k === 'id' || k === 'research_edits') return false;
    const v = content[k];
    if (isEmptyValue(v)) return false;
    return JSON.stringify(v) !== JSON.stringify(defaults[k]);
  });
}

/** One line of plain text describing some block content, for the review list. */
export function previewOf(content: Record<string, unknown> | string | null | undefined, max = 160): string {
  if (content == null) return '';
  if (typeof content === 'string') return trim(content.replace(/<[^>]*>/g, ' '), max);
  // Titles first, so a preview reads "Headline · summary", not the reverse.
  const rank = (k: string) => (/^(title|headline|name|group)$/.test(k) ? 0 : /summary|body|text/.test(k) ? 2 : 1);
  const order = (o: Record<string, unknown>) => Object.entries(o).sort(([a], [b]) => rank(a) - rank(b));
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (parts.join(' ').length > max) return;
    if (typeof v === 'string') { const t = v.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); if (t && !/^https?:\/\//.test(t)) parts.push(t); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') order(v as Record<string, unknown>).forEach(([k, x]) => { if (k !== 'id' && k !== 'key' && k !== 'research_edits') walk(x); });
  };
  for (const [k, v] of order(content)) {
    if (k === 'eyebrow' || k === 'id' || k === 'research_edits') continue;
    walk(v);
  }
  return trim(parts.join(' · '), max);
}

function trim(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function planGdocMerge(edition: NewsletterEdition, proposal: GdocProposal, templates: BlockTemplate[]): GdocChange[] {
  const out: GdocChange[] = [];
  if (proposal.subject) {
    const cur = (edition.subject ?? '').trim();
    if (cur !== proposal.subject.trim()) {
      out.push({ id: 'subject', kind: 'subject', label: 'Subject line', source_heading: null, conflict: cur !== '' && cur !== 'Untitled', current_preview: cur, incoming_preview: proposal.subject, research: false, target_block_id: null, block_type: '', incoming: proposal.subject });
    }
  }
  if (proposal.preheader) {
    const cur = (edition.preheader ?? '').trim();
    if (cur !== proposal.preheader.trim()) {
      out.push({ id: 'preheader', kind: 'preheader', label: 'Preheader', source_heading: null, conflict: cur !== '', current_preview: cur, incoming_preview: proposal.preheader, research: false, target_block_id: null, block_type: '', incoming: proposal.preheader });
    }
  }
  const byId = new Map(edition.blocks.map((b) => [b.id, b]));
  proposal.blocks.forEach((p, i) => {
    if (p.target_block_id && byId.has(p.target_block_id)) {
      const b = byId.get(p.target_block_id)!;
      const research = researchBindingOf(b.block_template) !== null;
      const current = research ? renderContentOf(b) : (b.content ?? {}) as Record<string, unknown>;
      out.push({
        id: `block:${b.id}`,
        kind: 'block',
        label: b.block_template.name || b.block_template.block_type,
        source_heading: p.source_heading,
        conflict: blockHasContent(b),
        current_preview: previewOf(current),
        incoming_preview: previewOf(p.content),
        research,
        target_block_id: b.id,
        block_type: b.block_template.block_type,
        incoming: p.content,
      });
    } else if (!p.target_block_id) {
      const tpl = templates.find((t) => t.block_type === p.block_type);
      if (!tpl) return;
      out.push({
        id: `new:${i}`,
        kind: 'new_block',
        label: tpl.name || p.block_type,
        source_heading: p.source_heading,
        conflict: false,
        current_preview: '',
        incoming_preview: previewOf(p.content),
        research: false,
        target_block_id: null,
        block_type: p.block_type,
        incoming: p.content,
      });
    }
  });
  return out;
}

/** The choice used when the author does not pick one: fill what is empty, keep what is not. */
export function defaultChoice(c: GdocChange): GdocChoice {
  return c.conflict ? 'keep' : 'doc';
}

function slugify(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
}

/**
 * The doc's value for a research block's output field, as an edit layer.
 * Array outputs: remove every researched item, add the doc's (grouped schemas
 * like `groups: [{ group, items: [...] }]` are flattened to items carrying
 * `group`, the shape the research layer stores). Text outputs: a value edit.
 * Null when the doc has nothing for that field or the binding hash is unknown.
 */
export function researchEditsFromDoc(block: EditionBlock, incoming: Record<string, unknown>): Record<string, unknown> | null {
  const binding = researchBindingOf(block.block_template);
  const hash = block.block_template.binding_hash;
  if (!binding || !hash) return null;
  const field = binding.output.field;
  const value = incoming[field];
  const format = researchOutputFormat(binding);
  if (format !== 'array') {
    if (typeof value !== 'string' || !value.trim()) return null;
    return { format, binding_hash: hash, value };
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const flat: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const nested = Object.entries(e).find(([, v]) => Array.isArray(v));
    if (nested) {
      const group = typeof e.group === 'string' ? e.group : null;
      for (const item of nested[1] as unknown[]) {
        if (item && typeof item === 'object') flat.push({ ...(item as Record<string, unknown>), ...(group ? { group } : {}) });
      }
    } else {
      flat.push(e);
    }
  }
  if (flat.length === 0) return null;
  const researched = (block.content?.[field] as unknown[] | undefined) ?? [];
  const removed = Array.isArray(researched)
    ? researched.map((i) => (i && typeof i === 'object' ? (i as { key?: unknown }).key : null)).filter((k): k is string => typeof k === 'string')
    : [];
  const added = flat.map((item, i) => ({ ...item, key: `gdoc:${i + 1}:${slugify(item.headline ?? item.title ?? item.url)}` }));
  return { format: 'array', binding_hash: hash, removed, added };
}

/** Fields a block keeps when the doc replaces its content: the section label. */
const KEEP_FIELDS = new Set(['eyebrow']);

/**
 * "Use document" replaces the block's content: every schema field goes back
 * to its default, then the doc's fields go on top. The section label and any
 * key outside the schema (e.g. an id) are kept. Without this, a field the
 * doc does not mention (an old read-more link) would survive from before.
 */
export function replaceContent(block: EditionBlock, incoming: Record<string, unknown>): Record<string, unknown> {
  const schema = schemaOf(block.block_template);
  const current = (block.content ?? {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) {
    if (!(k in schema) || KEEP_FIELDS.has(k)) kept[k] = v;
  }
  return { ...defaultsFor(schema), ...kept, ...incoming };
}

export interface GdocApplyResult {
  edition: NewsletterEdition;
  /** Research blocks whose edit layer to write (block id → edits). */
  researchEdits: Array<{ blockId: string; edits: Record<string, unknown> }>;
  applied: number;
  skipped: string[];
}

export function applyGdocMerge(
  edition: NewsletterEdition,
  changes: GdocChange[],
  choices: Record<string, GdocChoice>,
  templates: BlockTemplate[],
  newId: () => string,
): GdocApplyResult {
  let next: NewsletterEdition = { ...edition, blocks: [...edition.blocks] };
  const researchEdits: GdocApplyResult['researchEdits'] = [];
  const skipped: string[] = [];
  let applied = 0;
  let maxSort = edition.blocks.reduce((m, b) => Math.max(m, b.sort_order ?? 0), 0);

  for (const c of changes) {
    if ((choices[c.id] ?? defaultChoice(c)) !== 'doc') continue;
    if (c.kind === 'subject') { next = { ...next, subject: c.incoming as string }; applied++; continue; }
    if (c.kind === 'preheader') { next = { ...next, preheader: c.incoming as string }; applied++; continue; }
    const incoming = c.incoming as Record<string, unknown>;
    if (c.kind === 'block' && c.target_block_id) {
      const idx = next.blocks.findIndex((b) => b.id === c.target_block_id);
      if (idx < 0) continue;
      const block = next.blocks[idx];
      if (c.research) {
        const binding = researchBindingOf(block.block_template)!;
        const edits = researchEditsFromDoc(block, incoming);
        const rest = { ...incoming };
        delete rest[binding.output.field];
        if (edits) researchEdits.push({ blockId: block.id, edits });
        else if (incoming[binding.output.field] !== undefined) skipped.push(c.label);
        if (Object.keys(rest).length > 0) {
          // Only the doc's own non-research fields; the research field and
          // the edit layer stay as they are (the edit layer is written above).
          next.blocks[idx] = { ...block, content: { ...block.content, ...rest } };
        }
        if (edits || Object.keys(rest).length > 0) applied++;
      } else {
        next.blocks[idx] = { ...block, content: replaceContent(block, incoming) };
        applied++;
      }
      continue;
    }
    if (c.kind === 'new_block') {
      const tpl = templates.find((t) => t.block_type === c.block_type);
      if (!tpl) { skipped.push(c.label); continue; }
      maxSort += 1000;
      const block = {
        id: newId(),
        block_template: tpl,
        content: { ...defaultsFor(schemaOf(tpl)), ...incoming },
        sort_order: maxSort,
        bricks: [],
      } as unknown as EditionBlock;
      next = { ...next, blocks: [...next.blocks, block] };
      applied++;
    }
  }
  return { edition: next, researchEdits, applied, skipped };
}
