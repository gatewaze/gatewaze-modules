/**
 * Canonicalise a URL into a stable string for per-turn dedup.
 * Spec §6.8 — second identical fetch in one turn returns cached
 * bytes without re-billing.
 *
 * Rules:
 *   - lowercase scheme + host
 *   - strip default port (:443 on https)
 *   - sort query params + drop tracking params (utm_*, fbclid, gclid)
 *   - drop fragment
 *   - leave path as-is (case-sensitive — some servers care)
 *
 * Two URLs that canonicalise to the same string share a cache entry.
 * False positives (over-aggressive merging) are acceptable here
 * because the cache is turn-scoped — at worst the model sees stale
 * content for one extra question; the next turn fetches fresh.
 */

// utm_ matches as a prefix (utm_source, utm_medium, utm_campaign, …);
// the rest match exactly.
const TRACKING_PARAM_RE = /^(utm_.*|fbclid|gclid|mc_eid|mc_cid|igshid|_hsenc|_hsmi)$/i;

export function canonicaliseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Not a valid URL — return the trimmed raw form. Callers don't
    // assume canonicalisation succeeded; we only use it as a cache key.
    return raw.trim();
  }

  const params = new URLSearchParams();
  const entries = Array.from(u.searchParams.entries())
    .filter(([k]) => !TRACKING_PARAM_RE.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [k, v] of entries) params.append(k, v);

  const protocol = u.protocol.toLowerCase();
  const host = u.host.toLowerCase().replace(/:443$/, '').replace(/:80$/, '');
  const query = params.toString();
  return `${protocol}//${host}${u.pathname}${query ? `?${query}` : ''}`;
}
