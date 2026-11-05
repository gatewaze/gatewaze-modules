/**
 * Find a conference's programme starting from the only thing an event row
 * reliably carries: a link to its website.
 *
 * LF event sites publish the schedule three ways and none of them is
 * announced on the home page: a sched.com embed on /program/schedule/, a
 * Sessionize schedule rendered inline by the site's WordPress plugin, or a
 * hand-written page. The first two are found here. For the third there is
 * nothing machine-readable to import, so the result says which pages were
 * read and why none of them had a programme, and the admin sets the URL by
 * hand.
 *
 * Two traps this guards against, both seen on events.linuxfoundation.org:
 * - A schedule path that 301s to a DIFFERENT event's page (the site reuses
 *   slugs and redirects retired paths). A page that lands outside the
 *   event's own path prefix is discarded, never read.
 * - The inline plugin's markup: its config sits in a `data-sched-config`
 *   attribute as HTML-escaped JSON with `\/` escaped slashes, so neither the
 *   sched nor the Sessionize URL regex sees it unless the attribute is decoded
 *   first. decodeSchedConfig does that and hands the feed URL on.
 */

import { detectSource } from './index.js';
import type { GuardedFetch, ScheduleSource } from './types.js';

/** Paths worth reading on an event site, most specific first. */
const SCHEDULE_PATH_RE = /\/(program\/)?(schedule|schedule-at-a-glance|agenda|programme|program)\/?$/i;
const SCHEDULE_PATH_RANK: Array<RegExp> = [
  /\/program\/schedule\/?$/i,
  /\/schedule\/?$/i,
  /\/program\/schedule-at-a-glance\/?$/i,
  /\/schedule-at-a-glance\/?$/i,
  /\/(program\/)?agenda\/?$/i,
  /\/programme\/?$/i,
  /\/program\/?$/i,
];
const MAX_PAGES = 5;

export interface DiscoveryResult {
  source: ScheduleSource;
  resolvedUrl: string;
  /** The page the feed was found on, which may be the start page itself. */
  pageUrl: string;
  /**
   * For an API v2 feed found through the inline plugin: the hosted
   * <slug>.sessionize.com site named in the same config, whose /api/data
   * carries the event's timezone (the API v2 feed does not).
   */
  hostedOrigin?: string;
}

export interface DiscoveryFailure {
  /** Every page read, in order, so the admin can see what was tried. */
  pagesTried: string[];
  reason: string;
}

/**
 * Decode the inline Sessionize plugin's config. Returns the feed URL it
 * names, or null when the page is not an inline Sessionize schedule.
 *
 * The attribute value is HTML-escaped JSON (`&quot;`) whose slashes are
 * JSON-escaped (`https:\/\/`). Only the three keys that identify the feed
 * are read; the rest of the config (colours, filters) is ignored.
 */
export function decodeSchedConfig(html: string): { apiUrl: string | null; apiCode: string | null; publicSlug: string | null } | null {
  const m = /data-sched-config=(["'])([\s\S]*?)\1/i.exec(html);
  if (!m) return null;
  const json = m[2]
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const apiCode = str(cfg.sessionizeApiCode);
  const apiUrlRaw = str(cfg.sessionizeAllDataUrl);
  const apiUrl = apiUrlRaw && /^https:\/\/sessionize\.com\/api\/v2\/[A-Za-z0-9]+\/view\//i.test(apiUrlRaw)
    ? apiUrlRaw
    : apiCode && /^[A-Za-z0-9]{4,16}$/.test(apiCode)
      ? `https://sessionize.com/api/v2/${apiCode}/view/All`
      : null;
  const slugRaw = str(cfg.sessionizePublicSlug);
  const publicSlug = slugRaw && /^[a-z0-9-]{3,80}$/i.test(slugRaw) ? slugRaw.toLowerCase() : null;
  return { apiUrl, apiCode, publicSlug };
}

/**
 * The event's own path prefix on its site: `/kubecon-north-america/` → that.
 * A site root has no event prefix, so it returns null: discovery from the
 * root would accept any event's schedule page on the host.
 */
export function eventPathPrefix(startUrl: string): string | null {
  try {
    const u = new URL(startUrl);
    const first = u.pathname.split('/').filter(Boolean)[0];
    return first ? `/${first.toLowerCase()}/` : null;
  } catch {
    return null;
  }
}

/** True when `finalUrl` is on the same host and under the event's prefix. */
export function sameEvent(startUrl: string, finalUrl: string): boolean {
  try {
    const a = new URL(startUrl);
    const b = new URL(finalUrl);
    if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
    const prefix = eventPathPrefix(startUrl);
    if (!prefix) return false;
    return `${b.pathname.toLowerCase()}/`.startsWith(prefix) || b.pathname.toLowerCase() === prefix.replace(/\/$/, '');
  } catch {
    return false;
  }
}

/**
 * Links on the page that look like a schedule, same host, under the event's
 * prefix, deduplicated and ranked. The event's own conventional path is
 * always included first even when the page does not link to it.
 */
export function scheduleCandidateLinks(startUrl: string, html: string, max = MAX_PAGES): string[] {
  const prefix = eventPathPrefix(startUrl);
  if (!prefix) return [];
  const origin = new URL(startUrl).origin;
  const found = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"'#?]+)/gi)) {
    let u: URL;
    try { u = new URL(m[1], startUrl); } catch { continue; }
    if (u.origin !== origin) continue;
    const path = u.pathname.replace(/\/?$/, '/');
    if (!path.toLowerCase().startsWith(prefix)) continue;
    if (!SCHEDULE_PATH_RE.test(path.replace(/\/$/, '') + '/')) continue;
    found.add(`${origin}${path}`);
  }
  found.add(`${origin}${prefix}program/schedule/`);
  // Rank once per link, not inside the comparator: a page can carry a great
  // many links and the comparator runs n log n times.
  const ranked = [...found].map((url) => {
    const path = new URL(url).pathname;
    const i = SCHEDULE_PATH_RANK.findIndex((re) => re.test(path));
    return { url, rank: i < 0 ? SCHEDULE_PATH_RANK.length : i };
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.url.localeCompare(b.url)).slice(0, max).map((r) => r.url);
}

/**
 * Read a page and return the first schedule source it carries. The inline
 * Sessionize config is tried before the generic detectors because its feed
 * URL is only visible once the attribute is decoded.
 */
export function detectOnPage(pageUrl: string, html: string): { source: ScheduleSource; resolvedUrl: string; hostedOrigin?: string; inline: boolean } | null {
  const cfg = decodeSchedConfig(html);
  if (cfg?.apiUrl) {
    const hit = detectSource(cfg.apiUrl);
    if (hit) return { ...hit, inline: true, hostedOrigin: cfg.publicSlug ? `https://${cfg.publicSlug}.sessionize.com` : undefined };
  }
  const hit = detectSource(pageUrl, html);
  return hit ? { ...hit, inline: false } : null;
}

/**
 * A hosted <slug>.sessionize.com link is a weaker find than the inline
 * plugin's API v2 feed: the hosted feed can be published without speaker
 * links (PyTorch 2026 served 280 speakers and no links, while the API v2
 * feed behind the same site carried 163 LinkedIn profiles). So a hosted hit
 * on the event's home page is kept as the fallback while the schedule pages
 * are read for an inline config.
 */
function isWeakHit(hit: { source: ScheduleSource; inline: boolean }): boolean {
  return hit.source.kind === 'sessionize' && !hit.inline;
}

/**
 * Start at `startUrl` (a feed URL, a schedule page, or an event home page)
 * and find the programme. Every fetch goes through the caller's guarded
 * fetch, so the allowlist and the SSRF checks apply to each page read.
 */
export async function discoverSchedule(
  startUrl: string,
  get: GuardedFetch,
  log: (m: string) => void = () => {},
): Promise<DiscoveryResult | DiscoveryFailure> {
  const pagesTried: string[] = [];

  // A feed URL needs no page read at all.
  const direct = detectSource(startUrl);
  if (direct) return { ...direct, pageUrl: startUrl };

  if (!eventPathPrefix(startUrl)) {
    return { pagesTried, reason: 'the event link is a site root, not an event page; set the schedule URL by hand' };
  }
  // A page the guard refuses (redirect chain too long, host not allowed
  // after a redirect, timeout) is "unreadable", not a failure of the import:
  // discovery moves on and the admin sees which page it could not read.
  const read = async (url: string): Promise<{ ok: boolean; status: number; text: string; finalUrl?: string } | { refused: string }> => {
    try {
      return await get(url);
    } catch (err) {
      return { refused: String((err as Error)?.message ?? err).slice(0, 160) };
    }
  };

  const start = await read(startUrl);
  pagesTried.push(startUrl);
  if ('refused' in start) return { pagesTried, reason: `could not read the event page: ${start.refused}` };
  if (!start.ok) return { pagesTried, reason: `schedule page returned ${start.status}` };

  // The site may redirect the event link to its canonical slug
  // (/pytorch-conference/ → /pytorch-conference-north-america/). That is
  // still this event, so the landing URL becomes the event's prefix. A
  // redirect to another host is not followed anywhere.
  let eventUrl = startUrl;
  if (start.finalUrl && start.finalUrl !== startUrl) {
    if (!sameHost(startUrl, start.finalUrl) || !eventPathPrefix(start.finalUrl)) {
      return { pagesTried, reason: `event page redirected away from the site (${start.finalUrl})` };
    }
    if (!sameEvent(startUrl, start.finalUrl)) {
      // Only an alias of the same slug is followed (/pytorch-conference/ →
      // /pytorch-conference-north-america/). A retired edition that now
      // redirects to the next year's event (/foo-2023/ → /foo-2025/) would
      // import the wrong programme, so that stops here.
      if (!slugAlias(startUrl, start.finalUrl)) {
        return { pagesTried, reason: `event page redirected to a different event (${start.finalUrl}); set the schedule URL by hand` };
      }
      log(`discovery: ${startUrl} now lives at ${start.finalUrl}`);
    }
    eventUrl = start.finalUrl;
  }
  let fallback: DiscoveryResult | null = null;
  const onStart = detectOnPage(eventUrl, start.text);
  if (onStart) {
    const result = { source: onStart.source, resolvedUrl: onStart.resolvedUrl, hostedOrigin: onStart.hostedOrigin, pageUrl: eventUrl };
    if (!isWeakHit(onStart)) return result;
    fallback = result;
  }

  for (const candidate of scheduleCandidateLinks(eventUrl, start.text)) {
    if (candidate === startUrl || candidate === eventUrl || pagesTried.includes(candidate)) continue;
    const page = await read(candidate);
    pagesTried.push(candidate);
    if ('refused' in page) { log(`discovery: ${candidate} unreadable (${page.refused})`); continue; }
    if (!page.ok) { log(`discovery: ${candidate} returned ${page.status}`); continue; }
    if (page.finalUrl && !sameEvent(eventUrl, page.finalUrl)) {
      log(`discovery: ${candidate} redirected outside the event (${page.finalUrl}); ignored`);
      continue;
    }
    const hit = detectOnPage(candidate, page.text);
    if (!hit) continue;
    const result = { source: hit.source, resolvedUrl: hit.resolvedUrl, hostedOrigin: hit.hostedOrigin, pageUrl: candidate };
    if (!isWeakHit(hit)) return result;
    fallback = fallback ?? result;
  }
  if (fallback) return fallback;
  return { pagesTried, reason: 'no sched.com or Sessionize programme found on the event site' };
}

/** Is the landing slug the start slug or a longer/shorter form of it? */
export function slugAlias(startUrl: string, finalUrl: string): boolean {
  const a = (eventPathPrefix(startUrl) ?? '').replace(/\//g, '');
  const b = (eventPathPrefix(finalUrl) ?? '').replace(/\//g, '');
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(`${short}-`);
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

export function isDiscoveryFailure(r: DiscoveryResult | DiscoveryFailure): r is DiscoveryFailure {
  return 'reason' in r;
}
