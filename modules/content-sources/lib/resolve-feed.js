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
 *
 * Bounded: at most MAX_ALTERNATES page alternates are tried, at most
 * MAX_REQUESTS fetches are made in total (site-as-feed, the page, the
 * alternates, then the probe paths until the budget runs out), and the whole
 * call stops starting new fetches after DEADLINE_MS. A hostile page with a
 * thousand <link rel=alternate> tags costs the same as an ordinary one.
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
export const MAX_ALTERNATES = 5;
/** 1 site-as-feed + 1 page + 12 probe paths. Alternates come out of the same budget. */
export const MAX_REQUESTS = 14;
export const DEADLINE_MS = 30_000;
const PER_FETCH_MS = 12_000;

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
 * True when the feed's registrable domain differs from the site's (a Medium
 * or Substack feed under a project's name). Shared with lib/sources.ts so the
 * resolver's flag and the activation rule agree.
 * @param {string} feedUrl
 * @param {string} siteUrl
 */
export function isCrossDomain(feedUrl, siteUrl) {
  return registrableDomain(hostOf(feedUrl)) !== registrableDomain(hostOf(siteUrl));
}

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
 * @param {{ fetch?: typeof fetchText, maxCandidates?: number, probeAll?: boolean, deadlineMs?: number, maxRequests?: number, now?: () => number }} [opts]
 * @returns {Promise<{ site_url: string, candidates: FeedCandidate[], errors: string[] }>}
 */
export async function resolveFeed(siteUrl, opts = {}) {
  const doFetch = opts.fetch ?? fetchText;
  const site = policeUrl(siteUrl);
  const errors = [];
  const seen = new Set();
  const candidates = [];
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? DEADLINE_MS);
  let requestsLeft = opts.maxRequests ?? MAX_REQUESTS;
  let budgetNoted = false;
  const noteBudget = (why) => {
    if (!budgetNoted) errors.push(`stopped early: ${why}`);
    budgetNoted = true;
  };
  /** Every fetch goes through here so the request cap and deadline hold. Returns null when out of budget. */
  const boundedFetch = async (url, { maxBytes }) => {
    const remaining = deadline - now();
    if (remaining <= 0) { noteBudget('time limit reached'); return null; }
    if (requestsLeft <= 0) { noteBudget('request limit reached'); return null; }
    requestsLeft--;
    return doFetch(url, { maxBytes, timeoutMs: Math.min(PER_FETCH_MS, remaining) });
  };
  const outOfBudget = () => requestsLeft <= 0 || deadline - now() <= 0;

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
      const r = await boundedFetch(u.toString(), { maxBytes: FEED_BYTES });
      if (!r) return;
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
        cross_domain: isCrossDomain(u.toString(), site.toString()),
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
      page = await boundedFetch(site.toString(), { maxBytes: PAGE_BYTES });
    } catch (e) {
      errors.push(`${site}: ${refusalText(e)}`);
    }
    if (page && page.status === 200 && page.text) {
      for (const alt of feedAlternates(page.text, page.finalUrl || site.toString()).slice(0, MAX_ALTERNATES)) {
        if (outOfBudget()) break;
        await consider(alt.href, 'alternate');
      }
    }
  }
  if (candidates.length === 0 || opts.probeAll) {
    const base = `${site.protocol}//${site.host}`;
    for (const p of PROBE_PATHS) {
      if (outOfBudget()) { noteBudget(requestsLeft <= 0 ? 'request limit reached' : 'time limit reached'); break; }
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
