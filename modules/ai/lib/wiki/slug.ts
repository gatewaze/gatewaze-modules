/**
 * Wiki slug (path) validation + resolution. spec-ai-memory-wiki.md §4.5.
 *
 * A slug is a path of 1–8 url-safe segments joined by '/'. Each segment is
 * lower-case alphanumeric plus '-' and '_' (underscore admitted, slightly
 * wider than the spec's published regex, so system/reserved slugs like
 * `_lint-report` and namespaces like `meta` are representable). No '..',
 * no leading/trailing slash, no trailing '-'/'_' run that breaks the round
 * trip to a file path.
 */

export const MAX_SLUG_SEGMENTS = 8;
export const MAX_SEGMENT_LEN = 64;

const SEGMENT_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;

/** Reserved top-level segments (own namespaces; not user page roots). */
export const RESERVED_TOP_SEGMENTS = new Set(['raw', '_lint']);

export interface SlugCheck {
  ok: boolean;
  reason?: string;
}

export function validateSlug(slug: string): SlugCheck {
  if (typeof slug !== 'string' || slug.length === 0) return { ok: false, reason: 'empty' };
  if (slug.startsWith('/') || slug.endsWith('/')) return { ok: false, reason: 'leading/trailing slash' };
  if (slug.includes('//')) return { ok: false, reason: 'empty segment' };
  if (slug.split('/').includes('..') || slug.includes('../') || slug.includes('/..')) {
    return { ok: false, reason: 'path traversal' };
  }
  const segments = slug.split('/');
  if (segments.length > MAX_SLUG_SEGMENTS) return { ok: false, reason: 'too many segments' };
  for (const seg of segments) {
    if (seg.length > MAX_SEGMENT_LEN) return { ok: false, reason: 'segment too long' };
    if (!SEGMENT_RE.test(seg)) return { ok: false, reason: `bad segment '${seg}'` };
  }
  return { ok: true };
}

export function isValidSlug(slug: string): boolean {
  return validateSlug(slug).ok;
}

/** Directory portion of a slug ('a/b/c' → 'a/b'; 'a' → ''). */
export function slugDir(slug: string): string {
  const i = slug.lastIndexOf('/');
  return i < 0 ? '' : slug.slice(0, i);
}

/**
 * Resolve a markdown relative link target (e.g. '../speakers/x.md') against the
 * directory of the source page's slug, returning a normalized slug (no '.md',
 * no leading 'wiki/'). Returns null if it escapes the root or is non-local.
 */
export function resolveRelativeLink(fromSlug: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null; // scheme/protocol-relative
  if (!target.toLowerCase().endsWith('.md')) return null; // only internal page links
  const clean = target.replace(/\.md$/i, '');
  const baseParts = fromSlug ? slugDir(fromSlug).split('/').filter(Boolean) : [];
  const parts = clean.startsWith('/') ? [] : [...baseParts];
  for (const raw of clean.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (parts.length === 0) return null; // escapes root
      parts.pop();
      continue;
    }
    parts.push(raw);
  }
  let resolved = parts.join('/');
  resolved = resolved.replace(/^wiki\//, ''); // mirror layout stores pages under wiki/
  return resolved.length > 0 ? resolved : null;
}
