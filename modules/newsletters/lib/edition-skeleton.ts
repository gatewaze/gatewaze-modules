/**
 * Seed a new edition from the template repo's `edition.json`.
 *
 * The templates ingest stores the repo's skeleton on the library as
 * `templates_libraries.new_edition_blocks` ({ version, blocks: [{ key,
 * content? }] }). This turns that list into editor blocks: each key is
 * resolved against the library's CURRENT block defs, the block's starting
 * content is the def's schema defaults (what dragging it from the palette
 * would give) with the skeleton's `content` merged over the top, and keys
 * the library doesn't have are skipped — a repo may list a block that only
 * lands in a later commit, and a stale key must not block creating editions.
 *
 * Pure: the page fetches the rows, this shapes them.
 */

export interface SkeletonBlock {
  key: string;
  content?: Record<string, unknown>;
}

export interface EditionSkeleton {
  version?: number;
  blocks: SkeletonBlock[];
}

/** The subset of a templates_block_defs row the editor's BlockTemplate needs. */
export interface SkeletonBlockDef {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  schema: Record<string, unknown> | null;
  html: string | null;
  rich_text_template?: string | null;
  has_bricks?: boolean | null;
  render_kind?: string | null;
  component_id?: string | null;
}

export interface SeededBlock {
  id: string;
  block_template: SkeletonBlockDef & {
    block_type: string;
    sort_order: number;
    content: { html_template: string; rich_text_template: string | null; has_bricks: boolean; schema: Record<string, unknown> };
  };
  content: Record<string, unknown>;
  sort_order: number;
  bricks: never[];
}

const MAX_BLOCKS = 50;
const MAX_CONTENT_DEPTH = 8;
const KEY_RX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when `v` is plain JSON data with no prototype-polluting keys. */
function isSafeJson(v: unknown, depth = 0): boolean {
  if (depth > MAX_CONTENT_DEPTH) return false;
  if (Array.isArray(v)) return v.every((item) => isSafeJson(item, depth + 1));
  if (isPlainObject(v)) return Object.keys(v).every((k) => !FORBIDDEN_KEYS.has(k) && isSafeJson(v[k], depth + 1));
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Narrow an unknown jsonb value to a skeleton; null when it isn't one.
 *
 * The ingest validates edition.json before writing the column, but the
 * column itself is writable by any admin of the host through PostgREST
 * (table-wide UPDATE grant), so the same rules are applied again here:
 * block keys must match the ingest's charset, a block's starting content
 * must be plain JSON without prototype keys (or it is dropped), and the
 * list is capped. Nothing here is trusted because of where it came from.
 */
export function asEditionSkeleton(value: unknown): EditionSkeleton | null {
  if (!isPlainObject(value)) return null;
  const blocks = value.blocks;
  if (!Array.isArray(blocks)) return null;
  const out: SkeletonBlock[] = [];
  for (const b of blocks.slice(0, MAX_BLOCKS)) {
    const key = typeof b === 'string' ? b : isPlainObject(b) && typeof b.key === 'string' ? b.key : null;
    if (!key || !KEY_RX.test(key)) continue;
    const content = isPlainObject(b) ? b.content : undefined;
    out.push(isPlainObject(content) && isSafeJson(content) ? { key, content } : { key });
  }
  return out.length > 0 ? { version: 1, blocks: out } : null;
}

export function buildSkeletonBlocks(args: {
  skeleton: EditionSkeleton;
  defs: ReadonlyArray<SkeletonBlockDef>;
  /** Schema defaults per block key (from the email registry's defaultProps). */
  defaultsFor: (key: string) => Record<string, unknown>;
  newId: () => string;
}): { blocks: SeededBlock[]; missing: string[] } {
  const byKey = new Map(args.defs.map((d) => [d.key, d]));
  const blocks: SeededBlock[] = [];
  const missing: string[] = [];
  for (const entry of args.skeleton.blocks) {
    const def = byKey.get(entry.key);
    if (!def) {
      if (!missing.includes(entry.key)) missing.push(entry.key);
      continue;
    }
    blocks.push({
      id: args.newId(),
      block_template: {
        ...def,
        block_type: def.key,
        sort_order: 0,
        content: {
          html_template: def.html ?? '',
          rich_text_template: def.rich_text_template ?? null,
          has_bricks: def.has_bricks ?? false,
          schema: def.schema ?? {},
        },
      },
      content: { ...args.defaultsFor(def.key), ...(entry.content ?? {}) },
      sort_order: (blocks.length + 1) * 1000,
      bricks: [],
    });
  }
  return { blocks, missing };
}
