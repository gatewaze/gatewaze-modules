/**
 * Variant precedence resolution (spec-sites-theme-kinds §7.6).
 *
 * Given a request's RenderContext (canonical flat form) and a list of
 * candidate variants for a (page_id, field_path), pick the winning variant
 * deterministically:
 *
 *   1. Eligibility: every key in variant.match_context MUST be present
 *      and equal in request.context. Variants with absent or mismatched
 *      keys are excluded entirely (not just down-scored).
 *   2. Specificity score = number of keys in match_context.
 *   3. Highest specificity wins.
 *   4. Tiebreaker on equal scores: most recent updated_at.
 *   5. Final tiebreaker: lexicographically smaller id (UUID).
 *
 * The SQL equivalent of this rule is documented at the bottom of this file.
 * Tests run the TS implementation against the spec's worked examples.
 */

import type { RenderContextFlat } from './render-context.js';

export interface VariantCandidate {
  id: string;
  match_context: RenderContextFlat;
  /** ISO 8601 timestamp; lexicographic comparison gives chronological order. */
  updated_at: string;
  /** The variant's content, returned by selectVariant when this variant wins. */
  content: unknown;
}

/**
 * Pure resolver. Returns null when no variant matches (caller falls back to
 * base content).
 */
export function selectVariant<V extends VariantCandidate>(
  variants: ReadonlyArray<V>,
  context: RenderContextFlat,
): V | null {
  let best: V | null = null;
  let bestScore = -1;

  for (const variant of variants) {
    const score = scoreEligibility(variant.match_context, context);
    if (score === null) continue;       // ineligible
    if (score > bestScore) {
      best = variant;
      bestScore = score;
      continue;
    }
    if (score === bestScore && best !== null) {
      // Tiebreaker 1: more recent updated_at wins
      if (variant.updated_at > best.updated_at) {
        best = variant;
        continue;
      }
      if (variant.updated_at === best.updated_at) {
        // Tiebreaker 2: lexicographically smaller id wins
        if (variant.id < best.id) {
          best = variant;
        }
      }
    }
  }

  return best;
}

/**
 * Returns the variant's specificity score (number of match_context keys
 * that are present AND equal in the request context), or null if the
 * variant is ineligible (any key in match_context is absent or mismatched).
 *
 * Empty match_context → score 0 (eligible always; matches every request).
 */
export function scoreEligibility(
  matchContext: RenderContextFlat,
  requestContext: RenderContextFlat,
): number | null {
  let score = 0;
  for (const [key, value] of Object.entries(matchContext)) {
    if (!(key in requestContext)) return null;
    if (requestContext[key] !== value) return null;
    score++;
  }
  return score;
}

/**
 * The SQL form of the §7.6 algorithm. The runtime API uses this query
 * directly via Supabase; the TS form is for tests + reference. The query
 * pre-filters with a GIN index on `match_context jsonb_path_ops` (created
 * in migration 007) so eligibility checks are O(log n) even at >50
 * variants per page.
 *
 *   SELECT id, content
 *   FROM pages_content_variants
 *   WHERE page_id = $1
 *     AND field_path = $2
 *     AND match_context @> $3::jsonb              -- eligibility (uses GIN)
 *   ORDER BY
 *     jsonb_object_keys_count(match_context) DESC, -- specificity
 *     updated_at DESC,                              -- recency tiebreaker
 *     id ASC                                        -- final tiebreaker
 *   LIMIT 1;
 *
 * Where `jsonb_object_keys_count(jsonb) → int` is a tiny SQL helper
 * (defined in migration 007 alongside canonical_jsonb). The `@>` operator
 * is the contains check: `variant.match_context @> request.context` reads
 * "every key/value pair in variant.match_context appears in request.context"
 * which is exactly the eligibility rule.
 */
export const SQL_SELECT_WINNING_VARIANT = `
  SELECT id, content, match_context
  FROM public.pages_content_variants
  WHERE page_id = $1
    AND field_path = $2
    AND match_context @> $3::jsonb
  ORDER BY
    (SELECT count(*) FROM jsonb_object_keys(match_context)) DESC,
    updated_at DESC,
    id ASC
  LIMIT 1;
`.trim();
