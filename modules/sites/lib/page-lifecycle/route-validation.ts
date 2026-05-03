/**
 * Route path validation + normalization (per spec-sites-module §4.2.5,
 * spec-sites-theme-kinds §7.2 route hygiene).
 *
 * Pages are addressed by `full_path` — a URL-style path beginning with `/`.
 * The runtime API and the editor both go through `normalizeRoute` to
 * collapse trailing slashes, strip duplicate slashes, and reject paths that
 * would let an attacker traverse outside the page namespace.
 */

const ROUTE_MAX_LENGTH = 2048;
const SEGMENT_REGEX = /^[A-Za-z0-9._~%!$&'()*+,;=:@-]+$/;

export interface NormalizedRoute {
  ok: true;
  path: string;
  segments: string[];
  isHomepage: boolean;
}

export interface RouteValidationError {
  ok: false;
  reason:
    | 'empty'
    | 'must_start_with_slash'
    | 'too_long'
    | 'contains_dotdot'
    | 'contains_null'
    | 'invalid_segment'
    | 'contains_query_or_fragment';
  detail?: string;
}

export type RouteValidationResult = NormalizedRoute | RouteValidationError;

/**
 * Normalize and validate a route path. Idempotent.
 *
 * Rules:
 *   - Must be a non-empty string starting with `/`
 *   - Each segment matches RFC 3986 unreserved + sub-delims + ":" / "@"
 *   - `..` segments rejected (no traversal even after normalization)
 *   - Null bytes rejected (defense against path-injection attacks)
 *   - Query strings and fragments rejected (route is the path only)
 *   - Trailing slashes stripped, duplicate slashes collapsed
 *   - `/` is the homepage; `isHomepage` is true iff path === '/'
 */
export function normalizeRoute(input: unknown): RouteValidationResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (input.length > ROUTE_MAX_LENGTH) {
    return { ok: false, reason: 'too_long', detail: `max ${ROUTE_MAX_LENGTH} chars` };
  }
  if (!input.startsWith('/')) {
    return { ok: false, reason: 'must_start_with_slash' };
  }
  if (input.includes('\0')) {
    return { ok: false, reason: 'contains_null' };
  }
  if (input.includes('?') || input.includes('#')) {
    return { ok: false, reason: 'contains_query_or_fragment' };
  }

  const rawSegments = input.split('/').filter((s) => s.length > 0);
  for (const seg of rawSegments) {
    if (seg === '..') return { ok: false, reason: 'contains_dotdot' };
    if (!SEGMENT_REGEX.test(seg)) {
      return { ok: false, reason: 'invalid_segment', detail: seg };
    }
  }

  const path = rawSegments.length === 0 ? '/' : '/' + rawSegments.join('/');
  return {
    ok: true,
    path,
    segments: rawSegments,
    isHomepage: path === '/',
  };
}

/**
 * Compose a child route path under a parent. Used by the editor to derive
 * `full_path` when a page's slug or parent_page_id changes.
 */
export function joinRoute(parentPath: string, childSlug: string): RouteValidationResult {
  const parent = normalizeRoute(parentPath);
  if (!parent.ok) return parent;
  if (typeof childSlug !== 'string' || childSlug.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (childSlug.includes('/')) {
    return { ok: false, reason: 'invalid_segment', detail: 'slug cannot contain /' };
  }
  if (!SEGMENT_REGEX.test(childSlug) || childSlug === '..') {
    return { ok: false, reason: 'invalid_segment', detail: childSlug };
  }
  const joined = parent.path === '/' ? `/${childSlug}` : `${parent.path}/${childSlug}`;
  return normalizeRoute(joined);
}
