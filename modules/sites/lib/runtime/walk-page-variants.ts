/**
 * Apply per-field variant overlays to a page's default content.
 *
 * Per spec-aaif-theme-deliverable §5.2. Given:
 *   - `defaultContent`: the page's `pages.content` jsonb (default values
 *     for every field; no variant data — this is what publishes to git)
 *   - `variants`: rows from `page_variants` for this page (per-field
 *     overlays with `match_context`, ordered by editor priority)
 *   - `context`: the canonical `RenderContextFlat` for the request
 *
 * Produce a merged content tree where each personalized field has been
 * replaced with its winning variant's value (or left as default if no
 * variant matched).
 *
 * Resolution per field follows §5.2.3:
 *   1. Filter variants to those whose `match_context` is fully satisfied
 *      by the request context (all axes match — but axis values may be
 *      arrays meaning OR).
 *   2. Sort by: specificity (more axes matched, descending), then
 *      editor priority (ascending), then variant id (ascending) for
 *      determinism.
 *   3. The first variant wins; its `value` replaces the field.
 *
 * Implementation notes:
 *   - Field paths use the JSON-path-style convention agreed in the
 *     migration: dot for nested objects, brackets for array indices.
 *     `heroTitle`, `hero.subtitle`, `contentBlocks`, `contentBlocks[2].title`.
 *   - We mutate a CLONE of `defaultContent`, never the original.
 *   - When a variant targets `contentBlocks` (whole array), the variant's
 *     `value` REPLACES the array — this is how persona-specific block
 *     reordering and show/hide are expressed (§5.2.2). Unlike a delta,
 *     so the editor authoring UI needs to surface "this overrides the
 *     whole array" clearly.
 *   - Unknown field paths (variant targets a field that doesn't exist
 *     in defaults) are logged via the optional `onWarning` callback and
 *     skipped — never crash on stale variants.
 */

import type { RenderContextFlat } from './render-context.js';

export interface PageVariantInput {
  id: string;
  field_path: string;
  match_context: Record<string, unknown>;
  value: unknown;
  priority: number;
  updated_at: string;
}

export interface WalkPageVariantsArgs {
  defaultContent: Record<string, unknown>;
  variants: ReadonlyArray<PageVariantInput>;
  context: RenderContextFlat;
  /** Called with each non-fatal issue surfaced during the walk. */
  onWarning?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface WalkPageVariantsResult {
  /** The merged content tree. Always a fresh object — never aliased with `defaultContent`. */
  content: Record<string, unknown>;
  /** Per-field-path: the variant id that won, or null if no variant matched (default used). */
  applied: Record<string, string | null>;
  /** Total variants considered (eligibility-filtered). */
  considered: number;
  /** Total field paths that received an overlay. */
  overlayed: number;
}

export function walkPageVariants(args: WalkPageVariantsArgs): WalkPageVariantsResult {
  const merged = structuredClone(args.defaultContent);
  const applied: Record<string, string | null> = {};

  // Group variants by field_path so we resolve one winner per field.
  const byPath = new Map<string, PageVariantInput[]>();
  for (const v of args.variants) {
    const arr = byPath.get(v.field_path) ?? [];
    arr.push(v);
    byPath.set(v.field_path, arr);
  }

  let considered = 0;
  let overlayed = 0;

  for (const [fieldPath, candidates] of byPath) {
    const winner = pickWinner(candidates, args.context);
    considered += candidates.length;
    if (!winner) {
      applied[fieldPath] = null;
      continue;
    }

    // Apply the winning value at the field path. If the path doesn't
    // resolve in the default content tree, log + skip (this happens
    // when an editor renames a field but variants for the old name
    // weren't cleaned up).
    const written = setAtPath(merged, fieldPath, winner.value);
    if (!written.ok) {
      args.onWarning?.('walkPageVariants.path_unresolved', {
        field_path: fieldPath,
        variant_id: winner.id,
        reason: written.reason,
      });
      applied[fieldPath] = null;
      continue;
    }
    applied[fieldPath] = winner.id;
    overlayed += 1;
  }

  return { content: merged, applied, considered, overlayed };
}

// ---------------------------------------------------------------------------
// Variant selection (per spec §5.2.3)
// ---------------------------------------------------------------------------

function pickWinner(
  candidates: ReadonlyArray<PageVariantInput>,
  context: RenderContextFlat,
): PageVariantInput | null {
  // Filter to eligible variants + score them.
  const scored: Array<{ variant: PageVariantInput; specificity: number }> = [];
  for (const v of candidates) {
    const specificity = scoreVariantEligibility(v.match_context, context);
    if (specificity === null) continue;
    scored.push({ variant: v, specificity });
  }
  if (scored.length === 0) return null;

  // Sort per spec: specificity desc, priority asc, id asc.
  scored.sort((a, b) => {
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    if (a.variant.priority !== b.variant.priority) return a.variant.priority - b.variant.priority;
    if (a.variant.updated_at !== b.variant.updated_at) {
      // More recent edit wins as an additional pre-id tiebreaker — matches
      // selectVariant's behaviour in the sibling module.
      return a.variant.updated_at > b.variant.updated_at ? -1 : 1;
    }
    return a.variant.id < b.variant.id ? -1 : 1;
  });

  return scored[0]!.variant;
}

/**
 * Score a variant's match_context against the request context.
 *
 * Returns:
 *   - `null` if the variant is ineligible (any axis fails to match)
 *   - the number of axes specified in match_context if all match
 *     (used as the specificity score; more axes = more specific)
 *
 * Multi-value matching: when a match_context value is an array, the
 * variant is eligible if the request's axis value is in the array.
 * Example: `{ persona: ["enterprise", "developer"] }` matches requests
 * with persona=enterprise OR persona=developer. This is the OR-of-tiers
 * pattern from spec §5.2.1.
 */
export function scoreVariantEligibility(
  matchContext: Record<string, unknown>,
  context: RenderContextFlat,
): number | null {
  let specificity = 0;
  for (const [axis, expected] of Object.entries(matchContext)) {
    const actual = context[axis];
    if (!axisValueMatches(actual, expected)) return null;
    specificity += 1;
  }
  return specificity;
}

function axisValueMatches(actual: unknown, expected: unknown): boolean {
  // Multi-value (OR): array on the variant side means "any of these".
  if (Array.isArray(expected)) {
    for (const v of expected) {
      if (axisScalarMatches(actual, v)) return true;
    }
    return false;
  }
  return axisScalarMatches(actual, expected);
}

function axisScalarMatches(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  // Boolean tolerance — middleware sometimes carries booleans as strings.
  if (typeof expected === 'boolean') {
    if (typeof actual === 'string') {
      return (expected && actual === 'true') || (!expected && actual === 'false');
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Field-path read/write
// ---------------------------------------------------------------------------

interface PathSegment {
  kind: 'key' | 'index';
  value: string | number;
}

/**
 * Parse a field-path string into segments.
 *
 *   "heroTitle"                  → [{key 'heroTitle'}]
 *   "hero.title"                 → [{key 'hero'}, {key 'title'}]
 *   "contentBlocks[2]"           → [{key 'contentBlocks'}, {index 2}]
 *   "contentBlocks[2].title"     → [{key 'contentBlocks'}, {index 2}, {key 'title'}]
 *
 * Returns null on syntactically invalid input. The caller treats null as
 * "variant points at a bad path" and warns + skips.
 */
export function parseFieldPath(path: string): PathSegment[] | null {
  if (!path) return null;
  const segments: PathSegment[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') {
      // Skip dots between segments; leading/trailing/double dots are
      // malformed.
      if (i === 0 || i === path.length - 1) return null;
      if (path[i - 1] === '.' || path[i - 1] === ']') {
        // ".foo" or "[2].foo" is fine; ".." or "[2].[3]" not.
        if (path[i - 1] === '.') return null;
      }
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
    // Read until next '.' or '['
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j += 1;
    const key = path.slice(i, j);
    if (!key) return null;
    segments.push({ kind: 'key', value: key });
    i = j;
  }
  return segments.length > 0 ? segments : null;
}

interface SetResult {
  ok: boolean;
  reason?: string;
}

/**
 * Set the value at `path` inside `target`, replacing whatever was there.
 *
 * Returns `ok: false` (with a reason) when:
 *   - the path doesn't parse
 *   - an intermediate segment doesn't exist or is the wrong type
 *     (e.g. trying to index `[0]` into a non-array)
 *
 * Doesn't mutate `target` until validation succeeds, so a partial write
 * doesn't leave the tree half-modified.
 */
export function setAtPath(target: Record<string, unknown>, path: string, value: unknown): SetResult {
  const segments = parseFieldPath(path);
  if (!segments) return { ok: false, reason: 'invalid_path_syntax' };

  // Walk the parent of the final segment, validating each step.
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
  // Allow assigning at the next index (append-style). Out-of-range > length
  // is rejected — variants don't sparse-fill arrays.
  if (idx > cursor.length) {
    return { ok: false, reason: 'final_index_out_of_range' };
  }
  cursor[idx] = value;
  return { ok: true };
}
