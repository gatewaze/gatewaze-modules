/**
 * Editor-side glue for research blocks (spec-content-discovery-and-
 * research-blocks.md §5.2). Pure except `withBindingHashes`, which hashes.
 *
 * Every place the editor turns a block's `content` into something a renderer
 * or the Puck canvas sees goes through `renderContentOf()`, which applies
 * `resolveBlockContent` from lib/research-merge for research blocks and
 * passes every other block through untouched. Nothing else reads the
 * research field raw.
 *
 * The two layers in `content` are written by two different writers:
 *   content.<output.field>   runs only (newsletters_research_write)
 *   content.research_edits   the editor only (newsletters_research_edits_write)
 * so the Puck round-trip must never write either back from canvas props;
 * `preserveResearchLayers` keeps the previously loaded values.
 */

import type { BlockTemplate, EditionBlock, ResearchBinding } from '../utils/types.js';
import { bindingHash, resolveBlockContent } from '../../lib/research-merge.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The research binding of a block template, or null for every other block. */
export function researchBindingOf(tpl: Pick<BlockTemplate, 'source_kind' | 'data_source'> | null | undefined): ResearchBinding | null {
  if (!tpl || tpl.source_kind !== 'research') return null;
  const ds = tpl.data_source;
  if (!isObj(ds) || ds.kind !== 'research') return null;
  const output = ds.output;
  if (!isObj(output) || typeof output.field !== 'string' || !output.field) return null;
  return ds as unknown as ResearchBinding;
}

/** The ai_use_cases id a recipe binding names (transform first, then input), or null for template-only research. */
export function researchUseCaseOf(binding: ResearchBinding | null): string | null {
  if (!binding) return null;
  const t = binding.transform;
  if (t && t.kind === 'recipe' && typeof t.use_case === 'string') return t.use_case;
  const i = binding.input;
  if (i && i.kind === 'recipe' && typeof i.use_case === 'string') return i.use_case;
  return null;
}

/** 'array' | 'richtext' | 'text' for the binding's output, defaulting from the stored value's shape. */
export function researchOutputFormat(binding: ResearchBinding, research: unknown): 'array' | 'richtext' | 'text' {
  return binding.output.format ?? (Array.isArray(research) ? 'array' : 'richtext');
}

/**
 * The content a renderer (EditionEmail, the Puck canvas, the legacy mustache
 * preview) should see for this block. A missing `binding_hash` resolves with
 * '' so an edit layer is set aside rather than applied against an unknown
 * binding version; callers load block defs through `withBindingHashes`.
 */
export function renderContentOf(block: Pick<EditionBlock, 'content' | 'block_template'>): Record<string, unknown> {
  const binding = researchBindingOf(block.block_template);
  const content = (block.content ?? {}) as Record<string, unknown>;
  if (!binding) return content;
  return resolveBlockContent(content, binding, block.block_template.binding_hash ?? '');
}

/**
 * Puck round-trip guard: whatever the canvas props say, the research layer
 * and the edit layer are the previously loaded values. Both are written by
 * their own RPCs, never by the whole-content save. When there is no previous
 * block (a block just dragged from the palette) the output field keeps its
 * schema default and no edit layer exists yet.
 */
export function preserveResearchLayers(
  tpl: Pick<BlockTemplate, 'source_kind' | 'data_source'>,
  next: Record<string, unknown>,
  prev: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const binding = researchBindingOf(tpl);
  if (!binding) return next;
  const out: Record<string, unknown> = { ...next };
  const field = binding.output.field;
  if (prev && field in prev) out[field] = prev[field];
  else if (!prev) out[field] = Array.isArray(next[field]) ? [] : next[field] ?? null;
  if (prev && 'research_edits' in prev) out.research_edits = prev.research_edits;
  else delete out.research_edits;
  return out;
}

/**
 * Stamp `binding_hash` onto every research block template. Hashes once per
 * distinct template id; non-research templates come back as-is.
 */
export async function withBindingHashes<T extends Pick<BlockTemplate, 'id' | 'source_kind' | 'data_source'>>(templates: T[]): Promise<(T & { binding_hash?: string })[]> {
  const hashes = new Map<string, string>();
  for (const t of templates) {
    if (hashes.has(t.id)) continue;
    const binding = researchBindingOf(t);
    if (binding) hashes.set(t.id, await bindingHash(binding));
  }
  return templates.map((t) => (hashes.has(t.id) ? { ...t, binding_hash: hashes.get(t.id)! } : t));
}
