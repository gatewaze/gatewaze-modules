/**
 * The two-layer model for research blocks (spec-content-discovery-and-
 * research-blocks.md §5.2), as one pure resolver.
 *
 *   content.<field>          the research layer: written only by runs, a flat
 *                            keyed list (array outputs) or a scalar
 *   content.research_edits   the edit layer: written only by the editor
 *
 * Rendering, preview, send and the editor read through resolveResearchField().
 * Nothing else reads the research field raw.
 *
 * Array edits: { overrides: {key: {field: value}}, removed: [key], added:
 * [item], pinned: [key] }. Order: removed → overrides → added → grouping →
 * pinned first then newest first → max_per_group / max_items. Caps come
 * last so a removal frees a slot and an addition takes one.
 *
 * Scalar/richtext edits: { value, from_run_id }; while present it wins,
 * sanitised the same way research output is (richtext keeps the inline
 * allow-list with https anchors, text and scalar become plain text).
 *
 * The output format is the binding's `output.format`, defaulting to 'array'
 * (researchOutputFormat). The worker, the resolver and the editor all use
 * that one function, so the shape a run writes is the shape every reader
 * expects; the templates parser requires an explicit format for a field
 * that is not an array.
 *
 * An edit layer made against a different binding (binding_hash mismatch)
 * is set aside: the resolver ignores it and reports `edits_set_aside`.
 */

import { sanitizeInline } from './sanitize-inline.js';

export interface ResearchItem {
  key: string;
  group?: string | null;
  published_at?: string | null;
  [k: string]: unknown;
}

export interface ArrayEdits {
  format: 'array';
  binding_hash: string;
  overrides?: Record<string, Record<string, unknown>>;
  removed?: string[];
  added?: ResearchItem[];
  pinned?: string[];
}

export interface ScalarEdits {
  format: 'scalar' | 'richtext' | 'text';
  binding_hash: string;
  value: unknown;
  from_run_id?: string | null;
}

export type ResearchEdits = ArrayEdits | ScalarEdits;

export interface TransformConfig {
  group_by?: 'foundation' | 'project' | string;
  max_items?: number;
  max_per_group?: number;
}

export interface ResolvedGroup {
  group: string;
  items: ResearchItem[];
}

export interface ResolveResult<T> {
  value: T;
  /** The edit layer was present but made against another binding version. */
  edits_set_aside: boolean;
  /** Keys in the edit layer that no longer exist in the research layer (stale overrides, stale pins). */
  stale_keys: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Narrow unknown jsonb to an edit layer, or null when it isn't one. */
export function asResearchEdits(v: unknown): ResearchEdits | null {
  if (!isObj(v) || typeof v.binding_hash !== 'string') return null;
  if (v.format === 'array') {
    return {
      format: 'array',
      binding_hash: v.binding_hash,
      overrides: isObj(v.overrides) ? (v.overrides as Record<string, Record<string, unknown>>) : undefined,
      removed: Array.isArray(v.removed) ? v.removed.filter((k): k is string => typeof k === 'string') : undefined,
      added: Array.isArray(v.added) ? v.added.filter((i): i is ResearchItem => isObj(i) && typeof i.key === 'string') : undefined,
      pinned: Array.isArray(v.pinned) ? v.pinned.filter((k): k is string => typeof k === 'string') : undefined,
    };
  }
  if (v.format === 'scalar' || v.format === 'richtext' || v.format === 'text') {
    return { format: v.format, binding_hash: v.binding_hash, value: v.value, from_run_id: typeof v.from_run_id === 'string' ? v.from_run_id : null };
  }
  return null;
}

// Edit-layer values are typed by an admin but rendered into emails; keep them
// text (tags stripped, angle brackets escaped) and keep urls https.
const cleanStr = (v: unknown): unknown => (typeof v === 'string' ? v.slice(0, 4000).replace(/<[^<>]*>/g, '').replace(/</g, '&lt;').replace(/>/g, '&gt;') : v);
const cleanItem = (item: Record<string, unknown>): ResearchItem => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (v == null || typeof v === 'object') continue;
    out[k] = k === 'url' ? (typeof v === 'string' && /^https:\/\/[^\s<>"']+$/i.test(v) ? v : '') : cleanStr(v);
  }
  return out as ResearchItem;
};

const ts = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * Resolve an ARRAY research field. Returns groups when `group_by` is set,
 * else a flat list.
 */
export function resolveResearchArray(
  research: unknown,
  edits: unknown,
  transform: TransformConfig,
  currentBindingHash: string,
): ResolveResult<ResearchItem[] | ResolvedGroup[]> {
  const base: ResearchItem[] = Array.isArray(research)
    ? research.filter((i): i is ResearchItem => isObj(i) && typeof i.key === 'string')
    : [];
  const e = asResearchEdits(edits);
  const usable = e && e.format === 'array' && e.binding_hash === currentBindingHash ? e : null;
  const setAside = !!e && !usable;

  const byKey = new Map<string, ResearchItem>();
  for (const item of base) byKey.set(item.key, { ...item });
  const stale: string[] = [];
  if (usable) {
    for (const k of usable.removed ?? []) {
      if (!byKey.delete(k)) stale.push(k);
    }
    for (const [k, ov] of Object.entries(usable.overrides ?? {})) {
      const cur = byKey.get(k);
      if (cur) byKey.set(k, { ...cur, ...cleanItem(ov), key: k });
      else stale.push(k);
    }
    for (const item of usable.added ?? []) byKey.set(item.key, { ...cleanItem(item), key: item.key, _added: true });
  }
  const pinned = new Set(usable?.pinned ?? []);
  for (const k of pinned) if (!byKey.has(k)) stale.push(k);

  const sortItems = (items: ResearchItem[]) =>
    items.sort((a, b) => {
      const ap = pinned.has(a.key) ? 1 : 0;
      const bp = pinned.has(b.key) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return ts(b.published_at) - ts(a.published_at);
    });

  let items = Array.from(byKey.values());
  if (transform.group_by) {
    const groups = new Map<string, ResearchItem[]>();
    for (const item of items) {
      const g = typeof item.group === 'string' && item.group ? item.group : String(item[transform.group_by] ?? 'Other');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(item);
    }
    let out: ResolvedGroup[] = Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, list]) => ({
        group,
        items: cap(sortItems(list), transform.max_per_group),
      }));
    if (transform.max_items && transform.max_items > 0) {
      let budget = transform.max_items;
      out = out.map((g) => {
        const take = g.items.slice(0, Math.max(0, budget));
        budget -= take.length;
        return { ...g, items: take };
      }).filter((g) => g.items.length > 0);
    }
    return { value: out, edits_set_aside: setAside, stale_keys: stale };
  }
  items = cap(sortItems(items), transform.max_items);
  return { value: items, edits_set_aside: setAside, stale_keys: stale };
}

function cap<T>(items: T[], n?: number): T[] {
  return n && n > 0 ? items.slice(0, n) : items;
}

export type ResearchOutputFormat = 'array' | 'richtext' | 'text';

/** The binding's output format; 'array' when the binding does not say. The one rule every writer and reader uses. */
export function researchOutputFormat(binding: { output: { format?: string } }): ResearchOutputFormat {
  const f = binding.output.format;
  return f === 'richtext' || f === 'text' ? f : 'array';
}

/**
 * Sanitise an edit-layer scalar for rendering: richtext keeps the inline
 * allow-list (https anchors only), text/scalar become plain text. Numbers and
 * booleans pass; anything else is not a usable edit (undefined).
 */
function cleanScalarEdit(v: unknown, format: string): unknown {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined;
  if (format === 'richtext') return sanitizeInline(v, { allowAnchors: true });
  return cleanStr(v);
}

/**
 * Resolve a SCALAR / richtext research field: the edit wins while present.
 * `format` is the binding's output format; the edit layer's own `format`
 * is used only when the caller does not know it.
 */
export function resolveResearchScalar(research: unknown, edits: unknown, currentBindingHash: string, format?: ResearchOutputFormat): ResolveResult<unknown> & { edited: boolean } {
  const e = asResearchEdits(edits);
  if (!e) return { value: research, edits_set_aside: false, stale_keys: [], edited: false };
  if (e.format === 'array' || e.binding_hash !== currentBindingHash) return { value: research, edits_set_aside: true, stale_keys: [], edited: false };
  // `{ format, binding_hash }` with no value is how the editor resets to
  // research: the layer exists but holds nothing, so research wins.
  if (e.value === undefined) return { value: research, edits_set_aside: false, stale_keys: [], edited: false };
  const value = cleanScalarEdit(e.value, format ?? e.format);
  if (value === undefined) return { value: research, edits_set_aside: false, stale_keys: [], edited: false };
  return { value, edits_set_aside: false, stale_keys: [], edited: true };
}

/**
 * The block content a renderer should see: the research field replaced by
 * its resolved value (grouped when the binding groups), the edit layer
 * removed. Non-research blocks pass through unchanged.
 */
export function resolveBlockContent(
  content: Record<string, unknown>,
  binding: { output: { field: string; format?: string }; transform?: TransformConfig & { kind?: string } } | null | undefined,
  currentBindingHash: string,
): Record<string, unknown> {
  if (!binding?.output?.field) return content;
  const field = binding.output.field;
  const { research_edits: edits, ...rest } = content;
  const research = content[field];
  const format = researchOutputFormat(binding);
  if (format === 'array') {
    const r = resolveResearchArray(research, edits, binding.transform ?? {}, currentBindingHash);
    return { ...rest, [field]: r.value };
  }
  const r = resolveResearchScalar(research, edits, currentBindingHash, format);
  return { ...rest, [field]: r.value };
}

export interface ResearchBindingLike {
  kind: 'research';
  output: { field: string; format?: string };
  transform?: TransformConfig & { kind?: string };
  [k: string]: unknown;
}

/**
 * The research binding of a block def row (`source_kind` + `data_source`),
 * or null for every other block.
 */
export function researchBindingFromDef(def: { source_kind?: string | null; data_source?: unknown } | null | undefined): ResearchBindingLike | null {
  if (!def || def.source_kind !== 'research') return null;
  const ds = def.data_source;
  if (!isObj(ds) || ds.kind !== 'research') return null;
  const output = ds.output;
  if (!isObj(output) || typeof output.field !== 'string' || !output.field) return null;
  return ds as unknown as ResearchBindingLike;
}

/**
 * Server-side and portal twin of the editor's renderContentOf(): the content
 * a public surface (View Online, the git edition.json) should carry for a
 * block, given its def row. Research blocks resolve through the edit layer
 * and lose `research_edits`; every other block passes through. `hashes`
 * caches binding hashes by def id across the blocks of one edition.
 */
export async function resolveContentForDef(
  content: Record<string, unknown> | null | undefined,
  def: { id?: string; source_kind?: string | null; data_source?: unknown } | null | undefined,
  hashes: Map<string, string> = new Map(),
): Promise<Record<string, unknown>> {
  const c = (content ?? {}) as Record<string, unknown>;
  const binding = researchBindingFromDef(def);
  if (!binding) {
    if (!('research_edits' in c)) return c;
    const { research_edits: _drop, ...rest } = c;
    return rest;
  }
  const cacheKey = def?.id ?? canonicalJson(binding);
  let hash = hashes.get(cacheKey);
  if (hash === undefined) {
    hash = await bindingHash(binding);
    hashes.set(cacheKey, hash);
  }
  return resolveBlockContent(c, binding, hash);
}

/** sha1 of the canonical JSON of a binding; the edit layer records which version it was made against. */
export async function bindingHash(binding: unknown): Promise<string> {
  const text = canonicalJson(binding);
  const g = globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } };
  if (g.crypto?.subtle) {
    const buf = await g.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Only reached where Web Crypto is missing (old Node); kept out of
  // browser bundles, which always have crypto.subtle.
  const { createHash } = await import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:crypto');
  return createHash('sha1').update(text).digest('hex');
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
