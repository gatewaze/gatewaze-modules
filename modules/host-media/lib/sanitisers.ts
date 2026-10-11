import { MEDIA_PATCH_FIELDS } from '../types/index.js';

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

/**
 * parseUuidList — validates a caller-supplied id array for the bulk
 * endpoints. Returns the de-duplicated list, or null when the value is
 * not an array, is empty, exceeds `max`, or holds a non-UUID.
 */
export function parseUuidList(value: unknown, max = 500): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
  const out = new Set<string>();
  for (const v of value) {
    const id = paramAsUuid(v);
    if (!id) return null;
    out.add(id.toLowerCase());
  }
  return Array.from(out);
}

const ACCESS_LEVELS = new Set(['public', 'authenticated', 'signed']);
const MAX_TEXT = 2000;

/**
 * validateMediaPatch — type-checks the allowlisted PATCH fields that
 * pickFields() let through. pickFields only filters keys; without this a
 * caller could write `is_approved: "yes"` or a 1 MB caption. Returns the
 * cleaned object, or an error string naming the bad field.
 */
export function validateMediaPatch(
  fields: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const value: Record<string, unknown> = {};
  // Iterate the fixed field list, never the caller's keys, so every
  // written property name is a literal from this list.
  for (const key of MEDIA_PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const raw = fields[key];
    switch (key) {
      case 'caption':
      case 'alt_text':
        if (raw !== null && typeof raw !== 'string') return { ok: false, error: `${key} must be a string or null` };
        value[key] = typeof raw === 'string' ? raw.slice(0, MAX_TEXT) : null;
        break;
      case 'sponsor_id':
      case 'album_id':
        if (raw !== null && !paramAsUuid(raw)) return { ok: false, error: `${key} must be a UUID or null` };
        value[key] = raw;
        break;
      case 'is_featured':
      case 'is_approved':
        if (typeof raw !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
        value[key] = raw;
        break;
      case 'access_level':
        if (typeof raw !== 'string' || !ACCESS_LEVELS.has(raw)) {
          return { ok: false, error: 'access_level must be public, authenticated or signed' };
        }
        value[key] = raw;
        break;
    }
  }
  for (const key of Object.keys(fields)) {
    if (!(MEDIA_PATCH_FIELDS as readonly string[]).includes(key)) return { ok: false, error: `unknown field ${key}` };
  }
  return { ok: true, value };
}
