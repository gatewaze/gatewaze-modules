/**
 * Apply per-prop variant overlays to a blocks-mode page tree.
 *
 * Per spec-example-theme-deliverable §5.2 (extended for the Puck-unified
 * editor): variants stored in `page_variants` address fields inside a
 * specific block instance via a field_path keyed by the block's id.
 *
 * field_path conventions:
 *   `<block-instance-id>.<prop>`              — single prop override
 *   `<block-instance-id>.<prop>.<subprop>`    — nested object prop
 *   `<block-instance-id>.<prop>[<n>]`         — array index inside a prop
 *   `<block-instance-id>.<prop>[<n>].<sub>`   — nested in array item
 *
 * The first dot-separated segment is the page_blocks row id. UUIDs
 * contain hyphens but no `.` or `[`, so the existing parseFieldPath
 * tokeniser parses them as a single key segment. Subsequent segments
 * walk into the block's `content` jsonb the same way walkPageVariants
 * walks pages.content.
 *
 * Resolution algorithm matches §5.2.3 (and is shared with
 * walkPageVariants via pickWinner + scoreVariantEligibility):
 *   specificity desc → priority asc → updated_at desc → id asc.
 *
 * The walker mutates a CLONE of the tree, never the input. Unknown
 * field paths (variant points at a block id that no longer exists, or
 * a prop that was renamed) are logged via `onWarning` and skipped.
 */

import type { RenderContextFlat } from './render-context.js';
import {
  scoreVariantEligibility,
  type PageVariantInput,
} from './walk-page-variants.js';

export interface BlockNode {
  id: string;
  block_def_key: string;
  variant_key: string;
  sort_order: number;
  content: Record<string, unknown>;
}

export interface BrickNode {
  id: string;
  page_block_id: string;
  brick_def_key: string;
  variant_key: string;
  sort_order: number;
  content: Record<string, unknown>;
}

export interface BlockTreeInput {
  topLevel: ReadonlyArray<BlockNode>;
  bricks: ReadonlyArray<BrickNode>;
}

export interface BlockTreeOutput {
  topLevel: BlockNode[];
  bricks: BrickNode[];
}

export interface WalkBlockVariantsArgs {
  tree: BlockTreeInput;
  variants: ReadonlyArray<PageVariantInput>;
  context: RenderContextFlat;
  onWarning?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface WalkBlockVariantsResult {
  tree: BlockTreeOutput;
  /** Per field_path: winning variant id, or null when no variant matched. */
  applied: Record<string, string | null>;
  considered: number;
  overlayed: number;
}

export function walkBlockVariants(args: WalkBlockVariantsArgs): WalkBlockVariantsResult {
  // Deep-clone so we never mutate the caller's tree. structuredClone
  // is fast and preserves Date/Map shapes if anyone ever adds them.
  const tree: BlockTreeOutput = {
    topLevel: args.tree.topLevel.map(cloneBlock),
    bricks: args.tree.bricks.map(cloneBrick),
  };

  // Group variants by field_path to resolve one winner per field.
  const byPath = new Map<string, PageVariantInput[]>();
  for (const v of args.variants) {
    const arr = byPath.get(v.field_path) ?? [];
    arr.push(v);
    byPath.set(v.field_path, arr);
  }

  const blocksById = new Map<string, BlockNode>(tree.topLevel.map((b) => [b.id, b]));
  const bricksById = new Map<string, BrickNode>(tree.bricks.map((b) => [b.id, b]));

  const applied: Record<string, string | null> = {};
  let considered = 0;
  let overlayed = 0;

  for (const [fieldPath, candidates] of byPath) {
    considered += candidates.length;
    const winner = pickWinner(candidates, args.context);
    if (!winner) {
      applied[fieldPath] = null;
      continue;
    }

    const parsed = parseBlockFieldPath(fieldPath);
    if (!parsed) {
      args.onWarning?.('walkBlockVariants.unparseable_path', { field_path: fieldPath });
      applied[fieldPath] = null;
      continue;
    }

    const target = blocksById.get(parsed.instanceId) ?? bricksById.get(parsed.instanceId);
    if (!target) {
      args.onWarning?.('walkBlockVariants.instance_not_found', {
        field_path: fieldPath,
        variant_id: winner.id,
        instance_id: parsed.instanceId,
      });
      applied[fieldPath] = null;
      continue;
    }

    const writeOk = writePropPath(target.content, parsed.propPath, winner.value);
    if (!writeOk.ok) {
      args.onWarning?.('walkBlockVariants.prop_unresolved', {
        field_path: fieldPath,
        variant_id: winner.id,
        reason: writeOk.reason,
      });
      applied[fieldPath] = null;
      continue;
    }
    applied[fieldPath] = winner.id;
    overlayed += 1;
  }

  return { tree, applied, considered, overlayed };
}

// ---------------------------------------------------------------------------
// Variant selection (mirrors walk-page-variants; kept inline for clarity)
// ---------------------------------------------------------------------------

function pickWinner(
  candidates: ReadonlyArray<PageVariantInput>,
  context: RenderContextFlat,
): PageVariantInput | null {
  const scored: Array<{ variant: PageVariantInput; specificity: number }> = [];
  for (const v of candidates) {
    const specificity = scoreVariantEligibility(v.match_context, context);
    if (specificity === null) continue;
    scored.push({ variant: v, specificity });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    if (a.variant.priority !== b.variant.priority) return a.variant.priority - b.variant.priority;
    if (a.variant.updated_at !== b.variant.updated_at) {
      return a.variant.updated_at > b.variant.updated_at ? -1 : 1;
    }
    return a.variant.id < b.variant.id ? -1 : 1;
  });

  return scored[0]!.variant;
}

// ---------------------------------------------------------------------------
// field_path parsing — first segment is the block id, rest walks into content
// ---------------------------------------------------------------------------

interface ParsedBlockFieldPath {
  instanceId: string;
  /** propPath into block.content. Empty string means "replace block.content wholesale". */
  propPath: string;
}

export function parseBlockFieldPath(path: string): ParsedBlockFieldPath | null {
  if (!path) return null;
  // First segment: read up to '.', '[', or end of string.
  let i = 0;
  while (i < path.length && path[i] !== '.' && path[i] !== '[') i += 1;
  const instanceId = path.slice(0, i);
  if (!instanceId) return null;
  // Skip a leading '.' between block id and prop path.
  if (path[i] === '.') i += 1;
  // The remainder is the prop path; leave brackets in place since
  // walk-page-variants' parseFieldPath understands them.
  const propPath = path.slice(i);
  return { instanceId, propPath };
}

// ---------------------------------------------------------------------------
// Prop write — re-uses walk-page-variants semantics via setAtPath
// ---------------------------------------------------------------------------

interface WriteResult {
  ok: boolean;
  reason?: string;
}

function writePropPath(
  content: Record<string, unknown>,
  propPath: string,
  value: unknown,
): WriteResult {
  if (propPath === '') {
    // Whole-content replacement. Only legal when `value` is an object so
    // we don't lose the typed-record shape.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'whole_content_replacement_requires_object' };
    }
    // Replace in place — caller holds the same content object reference.
    for (const k of Object.keys(content)) delete content[k];
    Object.assign(content, value as Record<string, unknown>);
    return { ok: true };
  }
  // Delegate to walk-page-variants' setAtPath via a tiny re-implementation
  // — we can't import setAtPath because it's keyed off the same parser
  // that already parses block ids; we only need the post-instance portion
  // here. The implementation below mirrors setAtPath exactly.
  return setAtPath(content, propPath, value);
}

interface PathSegment {
  kind: 'key' | 'index';
  value: string | number;
}

function parseFieldPath(path: string): PathSegment[] | null {
  if (!path) return null;
  const segments: PathSegment[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') {
      if (i === 0 || i === path.length - 1) return null;
      if (path[i - 1] === '.') return null;
      i += 1;
      continue;
    }
    if (path[i] === '[') {
      const close = path.indexOf(']', i + 1);
      if (close === -1) return null;
      const idxRaw = path.slice(i + 1, close);
      if (!/^\d+$/.test(idxRaw)) return null;
      segments.push({ kind: 'index', value: Number(idxRaw) });
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j += 1;
    const key = path.slice(i, j);
    if (!key) return null;
    segments.push({ kind: 'key', value: key });
    i = j;
  }
  return segments.length > 0 ? segments : null;
}

function setAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): WriteResult {
  const segments = parseFieldPath(path);
  if (!segments) return { ok: false, reason: 'invalid_path_syntax' };

  let cursor: unknown = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    if (seg.kind === 'key') {
      if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
        return { ok: false, reason: `path_segment_not_object_at_${i}` };
      }
      const next = (cursor as Record<string, unknown>)[seg.value as string];
      if (next === undefined) {
        return { ok: false, reason: `path_segment_missing_at_${i}` };
      }
      cursor = next;
    } else {
      if (!Array.isArray(cursor)) {
        return { ok: false, reason: `path_segment_not_array_at_${i}` };
      }
      const idx = seg.value as number;
      if (idx >= cursor.length) {
        return { ok: false, reason: `path_index_out_of_range_at_${i}` };
      }
      cursor = cursor[idx];
    }
  }

  const last = segments[segments.length - 1]!;
  if (last.kind === 'key') {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return { ok: false, reason: 'final_parent_not_object' };
    }
    (cursor as Record<string, unknown>)[last.value as string] = value;
    return { ok: true };
  }
  if (!Array.isArray(cursor)) return { ok: false, reason: 'final_parent_not_array' };
  const idx = last.value as number;
  if (idx > cursor.length) {
    return { ok: false, reason: 'final_index_out_of_range' };
  }
  cursor[idx] = value;
  return { ok: true };
}

function cloneBlock(b: BlockNode): BlockNode {
  return { ...b, content: structuredClone(b.content) };
}

function cloneBrick(b: BrickNode): BrickNode {
  return { ...b, content: structuredClone(b.content) };
}
