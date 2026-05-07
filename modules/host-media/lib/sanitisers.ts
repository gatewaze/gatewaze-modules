/**
 * Search-string sanitiser for PostgREST .or() filter strings.
 * Strips PostgREST filter metacharacters AND escapes ILIKE wildcards
 * (`%`, `_`, `\`). Without escaping the wildcards, a user typing `%`
 * would match every row regardless of intent — caught in spec round 2
 * by gemini-2.5-flash.
 *
 * Per spec-host-media-module §8.3.
 */

const POSTGREST_METACHAR_RE = /[,()*\\]/g;
const ILIKE_WILDCARD_RE = /[%_]/g;
const MAX_LEN = 100;

export function sanitisePostgrestSearch(input: unknown): string {
  return String(input ?? '')
    .replace(POSTGREST_METACHAR_RE, '')
    .replace(ILIKE_WILDCARD_RE, '\\$&')
    .slice(0, MAX_LEN);
}

/**
 * pickFields — copies only the allowlisted keys from `body` to a new
 * object. Drops anything else, defending against mass-assignment
 * (e.g. `is_approved`, `host_id`, `id`) on PATCH endpoints.
 *
 * Per spec-host-media-module §8.2.
 */
export function pickFields<T extends string>(
  body: unknown,
  allowlist: readonly T[],
): Partial<Record<T, unknown>> {
  const out: Partial<Record<T, unknown>> = {};
  if (typeof body !== 'object' || body === null) return out;
  const src = body as Record<string, unknown>;
  for (const key of allowlist) {
    if (key in src) out[key] = src[key];
  }
  return out;
}

/**
 * uuid validation — strict v4 / v5 / v7 form. Returns the input string
 * if valid; null if not.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function paramAsUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return UUID_RE.test(value) ? value : null;
}

export function paramAsString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}
