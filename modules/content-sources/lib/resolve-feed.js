/**
 * Turn a site URL into feed candidates. Ported from the harvest's
 * probe_feed_candidates.sh plus the runbook's "adding a feed" rules.
 *
 * 1. Validate the site URL (https, public host).
 * 2. Fetch the page; collect <link rel="alternate" type="application/rss+xml|atom+xml">.
 * 3. If none, probe the known paths in order.
 * 4. Every candidate passes the same validation as the site URL and must
 *    share its registrable domain; otherwise it is returned flagged
 *    cross_domain and only an admin may save it.
 * 5. Each candidate must parse and have at least one dated entry. Liveness
 *    is judged by entry dates, never the feed-level <updated>.
 * 6. Prefer a section feed over a Hugo root index.xml.
 */

import { fetchText, policeUrl, FetchRefusedError } from './http.js';
import { parseFeed, looksLikeFeed } from './feed-parser.js';
import { feedAlternates } from './html-meta.js';
import { hostOf, registrableDomain, normalizeUrl } from './normalize-url.js';

export const PROBE_PATHS = [
  '/feed/',
  '/feed.xml',
  '/rss.xml',
  '/index.xml',
  '/atom.xml',
  '/blog/index.xml',
  '/blog/feed/',
  '/blog/rss.xml',
  '/blog/feed.xml',
  '/news/feed/',
  '/feed.rss',
  '/blog/atom.xml',
];

const PAGE_BYTES = 5 * 1024 * 1024;

// Errors go back to API-key and MCP callers. A refusal never echoes WHY
// (a resolved address would be an oracle for internal DNS); other failures
// are summarised without their message.
function refusalText(e) {
  if (e instanceof FetchRefusedError) return /scheme|not a URL|too long|port/.test(e.message) ? e.message : 'host not allowed';
  if (e?.name === 'AbortError' || /timeout/i.test(e?.message ?? '')) return 'timed out';
  return 'could not be fetched';
}
const FEED_BYTES = 2 * 1024 * 1024;

/**
 * @typedef {object} FeedCandidate
 * @property {string} feed_url
 * @property {'alternate'|'probe'} found_via
 * @property {'rss'|'atom'|'rdf'} kind
 * @property {string} feed_title
 * @property {number} entry_count
 * @property {string|null} newest_entry_at
 * @property {boolean} cross_domain
 * @property {boolean} is_root_index   Hugo-style root index.xml (site feed, not a blog feed)
 */

/**
 * @param {string} siteUrl
 * @param {{ fetch?: typeof fetchText, maxCandidates?: number, probeAll?: boolean }} [opts]
 * @returns {Promise<{ site_url: string, candidates: FeedCandidate[], errors: string[] }>}
 */
export async function resolveFeed(siteUrl, opts = {}) {
  const doFetch = opts.fetch ?? fetchText;
  const site = policeUrl(siteUrl);
  const siteDomain = registrableDomain(hostOf(site.toString()));
  const errors = [];
  const seen = new Set();
  const candidates = [];

  const consider = async (url, foundVia) => {
    let u;
    try {
      u = policeUrl(url);
    } catch (e) {
      errors.push(`${url}: ${refusalText(e)}`);
      return;
    }
    const key = normalizeUrl(u.toString());
    if (seen.has(key)) return;
    seen.add(key);
    try {
      const r = await doFetch(u.toString(), { maxBytes: FEED_BYTES, timeoutMs: 12_000 });
      if (r.status !== 200 || !looksLikeFeed(r.text)) return;
      const feed = parseFeed(r.text, u.toString());
      if (feed.kind === 'unknown') return;
      const dated = feed.entries.filter((e) => e.publishedAt || e.updatedAt);
      if (dated.length === 0) return;
      const newest = dated.map((e) => e.publishedAt ?? e.updatedAt).sort().at(-1) ?? null;
      candidates.push({
        feed_url: u.toString(),
        found_via: foundVia,
        kind: feed.kind,
        feed_title: feed.title,
        entry_count: feed.entries.length,
        newest_entry_at: newest,
        cross_domain: registrableDomain(hostOf(u.toString())) !== siteDomain,
        is_root_index: /^\/index\.xml$/i.test(u.pathname),
      });
    } catch (e) {
      errors.push(`${u.toString()}: ${refusalText(e)}`);
    }
  };

  // Maybe the user gave us the feed itself.
  await consider(site.toString(), 'alternate');
  if (candidates.length === 0) {
    let page = null;
    try {
      page = await doFetch(site.toString(), { maxBytes: PAGE_BYTES, timeoutMs: 12_000 });
    } catch (e) {
      errors.push(`${site}: ${refusalText(e)}`);
    }
    if (page && page.status === 200 && page.text) {
      for (const alt of feedAlternates(page.text, page.finalUrl || site.toString())) {
        await consider(alt.href, 'alternate');
      }
    }
  }
  if (candidates.length === 0 || opts.probeAll) {
    const base = `${site.protocol}//${site.host}`;
    for (const p of PROBE_PATHS) {
      await consider(base + p, 'probe');
      if (!opts.probeAll && candidates.length >= (opts.maxCandidates ?? 3)) break;
    }
  }

  // Section feed before a root index.xml; same-domain before cross-domain;
  // then newest entry first.
  candidates.sort((a, b) => {
    if (a.cross_domain !== b.cross_domain) return a.cross_domain ? 1 : -1;
    if (a.is_root_index !== b.is_root_index) return a.is_root_index ? 1 : -1;
    return String(b.newest_entry_at ?? '').localeCompare(String(a.newest_entry_at ?? ''));
  });
  return { site_url: site.toString(), candidates, errors };
}
