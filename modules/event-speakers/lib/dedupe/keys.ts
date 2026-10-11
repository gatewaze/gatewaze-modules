/**
 * The identity keys speaker dedupe matches on.
 *
 * Each of these has a mirror as an IMMUTABLE SQL function in migration 025, so
 * the worker and the database agree on what a key is. If you change one, change
 * both, and say so in the migration.
 *
 * Measured against 6,031 real profiles on 2026-10-11 before any of this was
 * written. What the data said, because it is not what you would guess:
 *
 *   - company is the NOISIEST field, not a corroborating one. Only 5 of 507
 *     duplicate-name groups agreed on company across every row. One person
 *     appeared under six spellings of their own employer, two of them typos.
 *   - the avatar URL alone is WRONG. Two different people, "Hai" and "Meri",
 *     share one avatar URL three times over, because for some events the
 *     scraped image is a session photo rather than a headshot.
 *   - a bare name is dangerous. There are two different people recorded only
 *     as "Ethan" and three different people recorded only as "Jeff".
 *
 * So nothing here matches on company, and nothing merges on a name alone.
 */

/**
 * The name key.
 *
 * Case-folded, punctuation collapsed to single spaces. `[^[:alnum:]]` in the
 * SQL mirror and this `\p{L}\p{N}` class both PRESERVE non-Latin scripts, which
 * matters more than it sounds: an earlier ASCII-stripping version collapsed 103
 * Korean and Japanese names to the empty string and reported them as one
 * 103-person duplicate group.
 */
export function nameKey(value: unknown): string {
  return String(value ?? '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

/** Tokens in the name key, used to refuse single-word names. */
export function nameTokens(value: unknown): string[] {
  const k = nameKey(value);
  return k ? k.split(' ').filter(Boolean) : [];
}

/**
 * Whether a name is specific enough to be evidence of anything.
 *
 * "Ethan" and "Jeff" are not. Two tokens is the bar for a Latin-script name.
 * A CJK name is commonly one token and still specific, so a single token of
 * two or more non-Latin characters also passes. A single Latin token never
 * does, however long it is, because "Madonna" and "Prince" are rarer in a
 * conference programme than a speaker who only gave their first name.
 */
export function nameIsSpecific(value: unknown): boolean {
  const tokens = nameTokens(value);
  if (tokens.length === 0) return false;
  if (tokens.length >= 2) return true;
  // One token: accept only if it is non-Latin script with at least 2 characters.
  const only = tokens[0];
  return only.length >= 2 && !/^[\p{Script=Latin}\p{N}]+$/u.test(only);
}

/**
 * The LinkedIn vanity slug, which is the strongest identifier we actually hold
 * at any scale (2,050 of 6,031 profiles).
 *
 * Returns null for anything that is not a LinkedIn profile URL, including a
 * company page, so a shared employer page can never be read as a shared
 * person.
 */
export function linkedinSlug(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const m = raw.match(/linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/i);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).trim().toLowerCase();
  return slug || null;
}

/**
 * The slug with LinkedIn's trailing disambiguator removed.
 *
 * NEVER used to auto-merge. `prakash-kalaiah` and `prakash-kalaiah-875542` are
 * the same person with two accounts, but `shaun.smith6` could be a different
 * Shaun Smith, and there is no way to tell from the string. This exists only
 * to raise a review candidate.
 */
export function linkedinSlugBase(value: unknown): string | null {
  const slug = linkedinSlug(value);
  if (!slug) return null;
  const base = slug.replace(/[-.](?:[0-9a-f]{6,}|\d{1,8})$/i, '');
  return base.length >= 4 ? base : slug;
}

/**
 * The global sched account id, parsed out of a sched avatar URL.
 *
 * Sched gives a speaker two identifiers and the obvious one is the weaker.
 * The slug in `/speaker/jones.angie` is derived from the name, is a hex
 * fallback for speakers without a sched account (32 of 107 on the AGNTcon
 * programme), and is not even unique per person: account 25691010 appears on
 * that one page under both `shaun.smith6` and `a541c24f08e01f...`.
 *
 * The numeric id in the avatar path is served from sched's global avatar CDN
 * rather than the event subdomain, and had 100% coverage on that page: 112
 * avatar URLs, 112 ids, 104 distinct people. That is the one to key on.
 *
 * Accepts the protocol-relative form sched actually emits.
 */
export function schedUserId(avatarUrl: unknown): string | null {
  const raw = String(avatarUrl ?? '').trim();
  if (!raw) return null;
  // //avatars.sched.co/<seg>/<2 hex>/<numeric id>/avatar.jpg?xxx
  const m = raw.match(/avatars\.sched\.co\/[0-9a-z]+\/[0-9a-f]{2}\/(\d{3,})\//i);
  return m ? m[1] : null;
}
