/**
 * Pure parsers for events.linuxfoundation.org markup.
 *
 * Split out of LinuxFoundationEventsScraper.js so they can be unit-tested
 * against committed fixtures: importing the scraper itself pulls in
 * BaseScraper → puppeteer-core, which a plain unit test should not need.
 *
 * ## Why the nav parser exists
 *
 * The scraper used to read every action-button URL off the listing card, which
 * is what the old LF template emitted:
 *
 *   <div id="post-NNNN" class="cell ... event callout">
 *     <h2 class="event-title"><a href="...event-slug/">Title</a></h2>
 *     <a href="..../register/">Register</a>
 *     <a href="..../program/schedule/">Schedule</a>
 *     ...
 *
 * LF has since changed that template (verified against the live site on
 * 2026-10-10). Cards are now `<article ... class="callout">` and carry no
 * action buttons at all — an upcoming card ends at "CFP Status: Closed", and a
 * past card carries a single "Videos" link. The Register / Sponsor / Schedule
 * buttons moved onto each event's own page, into
 * `<nav id="event-menu" class="event-menu ...">`, with Schedule nested one
 * level down under a "Program" parent whose own href is just `#`.
 *
 * The visible consequence: `source_details.action_links.schedule` stopped being
 * captured, so nothing downstream could find an event's schedule page without a
 * human pasting the URL in. The scraper already fetches each event's detail page
 * for JSON-LD enrichment, so the nav is free to read while we are there.
 */

// Tag openings only. The matching close tag is then found with indexOf, and
// attributes are read out of the short captured attribute string.
//
// Written this way on purpose, and the `{0,MAX_TAG_ATTR_BYTES}` bound is load-
// bearing rather than tidiness. These parsers now run over a whole fetched page
// instead of one small listing card, so the input is third-party HTML we do not
// control, and Node is single-threaded — one pathological page stalls the whole
// scraper worker, which no fetch timeout or try/catch catches. Measured on
// 20,000 repetitions of `<a href="x" ` with no `>` anywhere (240 KB, the size
// of a real LF page):
//
//   /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g   5.3 s at 1/16th that size
//   /<a\b([^>]*)>/gi                                  2.6 s
//   /<a\b([^>]{0,4000})>/gi                           0.2 s
//
// An opening tag longer than the bound is skipped. The longest `<a>` attribute
// string on the real AGNTCon page is 406 bytes and the longest tag of any kind
// is 1,161, so the bound has room to spare.
const MAX_TAG_ATTR_BYTES = 4000;
const TAG_OPEN_RE = {
  a: new RegExp(`<a\\b([^>]{0,${MAX_TAG_ATTR_BYTES}})>`, 'gi'),
  nav: new RegExp(`<nav\\b([^>]{0,${MAX_TAG_ATTR_BYTES}})>`, 'gi'),
};
const HREF_ATTR_RE = /\bhref="([^"]*)"/i;
const CLASS_ATTR_RE = /\bclass="([^"]*)"/i;
const NAV_TOKEN_RE = /<(\/?)nav\b/gi;

// An action button's visible text is a few words. Capping how far an anchor's
// body may run before we bother reading it is the second half of keeping this
// linear, and it is load-bearing for the same reason the attribute bound is.
// Caching the close-tag search alone is not enough: N well-formed
// `<a href="...">` openings sharing one distant `</a>` made every opening
// re-slice and re-strip the same long span, which measured 83 ms at 54 KB,
// 1.2 s at 216 KB and 4.9 s at 432 KB. Checking the distance first is O(1) per
// opening and costs nothing real — the longest action label LF uses is
// "Sponsorships".
const MAX_LABEL_BYTES = 500;

// Defence in depth: these parsers are linear, but an LF page is ~250 KB and
// there is no reason to walk a response orders of magnitude bigger than that.
const MAX_PARSE_BYTES = 4_000_000;

// The sched.com programme host, however the page happens to reference it:
//   <script src="//<host>.sched.com/js/embed.js">   (LF schedule page)
//   <iframe src="https://<host>.sched.com/...">     (older embeds)
//   <a href="https://<host>.sched.com/list/simple"> (AGNTCon's "View the
//                                                    Schedule" button)
// Matching the attribute rather than the element covers all three. Never derive
// the host from the event slug — Seoul is `mcpseoul2026`, AGNTCon + MCPCon
// Europe is `agntconmcpconeu26`.
// The label length is bounded at the DNS maximum of 63 so the quantifier
// cannot backtrack across an arbitrarily long run of `a`.
const SCHED_HOST_RE = /(?:href|src)="(?:https?:)?\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.sched\.com[\/"?#]/gi;

// sched.com's own infrastructure subdomains, which are never an event's
// programme host.
const SCHED_RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'help', 'support', 'blog', 'static', 'assets', 'cdn', 'img', 'm',
]);

export const ACTION_BUTTON_LABELS = new Set([
  'register', 'sponsor', 'schedule', 'videos', 'speak',
  // Less common but observed:
  'attend', 'sponsorships', 'agenda', 'program', 'tickets',
]);


// Decode HTML entities — named, decimal (&#39;) AND hex (&#x27;). Scraped pages
// mix all three; handling only named+decimal leaked raw hex entities into text.
export function decodeHtmlEntities(input) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', deg: '°', middot: '·', bull: '•' };
  const toChar = (code, orig) => {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return orig;
    try { return String.fromCodePoint(code); } catch { return orig; }
  };
  return String(input == null ? '' : input)
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, h) => toChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => toChar(parseInt(d, 10), m))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) => named[n] ?? named[n.toLowerCase()] ?? m);
}

export function stripTags(html) {
  return decodeHtmlEntities(
    String(html == null ? '' : html)
      .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}


/**
 * An action link is only worth storing if it goes somewhere. The nav's
 * dropdown parents ("Attend", "Program", "Features & Add-Ons") are
 * `<a href="#">`, and they carry labels that are in the allowlist — stored
 * unfiltered they would shadow the real child link.
 *
 * Returns the URL re-serialised through `URL`, or null. Two things that buys:
 * a `javascript:` or `data:` href can never be persisted as an action URL
 * whatever entity-encoding it arrives in (the href is decoded first, then the
 * scheme is checked), and the stored string is percent-encoded, so a value
 * like `https://x.test/?a="><script>` cannot break out of an attribute in
 * whatever renders it next. These URLs go into `events.source_details` for
 * other modules to read, so they are sanitised at the point they are captured
 * rather than left to each future consumer.
 */
function usableActionHref(rawHref) {
  const decoded = decodeHtmlEntities(rawHref).trim();
  let url;
  try {
    url = new URL(decoded);
  } catch {
    return null; // not absolute, or not parseable at all
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/**
 * Collect `{ label: url }` for every allowlisted action label in `html`.
 * First occurrence of a label wins, and `into` is never overwritten — so the
 * caller controls precedence by the order it passes HTML in.
 */
function collectActionLinks(html, into) {
  if (!html || html.length > MAX_PARSE_BYTES) return into;
  const open = TAG_OPEN_RE.a;
  open.lastIndex = 0;
  let m;
  // Anchors do not nest in valid HTML, so the first `</a>` at or after the
  // opening tag closes it. Opening tags come out in document order, so a close
  // position still ahead of the next one is still that one's close — caching it
  // keeps the total scanning linear instead of re-walking the tail of the
  // document once per anchor.
  let close = -1;
  while ((m = open.exec(html)) !== null) {
    const textStart = open.lastIndex;
    if (close < textStart) {
      close = html.indexOf('</a>', textStart);
      if (close === -1) break; // no closing tag left anywhere in the document
    }
    // Too far away to be a button's label, so don't read it. Checked before the
    // slice so the work per opening tag is bounded, not just the indexOf.
    if (close - textStart > MAX_LABEL_BYTES) continue;
    const label = stripTags(html.slice(textStart, close)).toLowerCase();
    if (!label || !ACTION_BUTTON_LABELS.has(label)) continue;
    if (label in into) continue;
    const hrefMatch = HREF_ATTR_RE.exec(m[1]);
    if (!hrefMatch) continue;
    const href = usableActionHref(hrefMatch[1]);
    if (!href) continue;
    into[label] = href;
  }
  return into;
}

/**
 * Action links from one listing card. Kept because the archive layout's
 * "Videos" link lives only here — it is not in the event page's nav.
 */
export function extractCardActionLinks(cardHtml) {
  return collectActionLinks(cardHtml, {});
}

/**
 * Where the `<nav>` opened at `bodyStart` ends, depth-matched. HTML5 allows a
 * `<nav>` inside a `<nav>`, so taking the first `</nav>` would end the outer one
 * early and drop every link between the inner close and the real one. Returns
 * the document length when the nav is never closed, which is what the old
 * first-match behaviour did and is the useful answer for a truncated page.
 */
function navBodyEnd(html, bodyStart) {
  NAV_TOKEN_RE.lastIndex = bodyStart;
  let depth = 1;
  let m;
  while ((m = NAV_TOKEN_RE.exec(html)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return html.length;
}

/**
 * Action links from an event detail page's `nav.event-menu` — Register,
 * Sponsor, Schedule and friends, including the ones nested under a dropdown
 * parent. Scoped to the nav so a stray "Register" in the page body cannot
 * win over the real nav entry.
 */
export function extractNavActionLinks(pageHtml) {
  const links = {};
  if (!pageHtml || pageHtml.length > MAX_PARSE_BYTES) return links;
  // Matched on the class rather than the id because LF renders the same menu
  // more than once per page (desktop + mobile popout) and only one copy can own
  // `id="event-menu"`. <nav> does not nest, so the first </nav> closes it.
  const open = TAG_OPEN_RE.nav;
  open.lastIndex = 0;
  let m;
  // Never scan the same bytes twice. A page carrying many `<nav>` openings that
  // share one distant `</nav>` would otherwise hand collectActionLinks almost
  // the whole document once per opening, which is quadratic however cheap each
  // pass is. Because the body end is depth-matched, an opening that falls
  // inside a body already scanned is a nested nav, and its links were already
  // collected by the enclosing pass.
  let scannedTo = 0;
  while ((m = open.exec(pageHtml)) !== null) {
    const classAttr = CLASS_ATTR_RE.exec(m[1]);
    if (!classAttr) continue;
    if (!classAttr[1].split(/\s+/).includes('event-menu')) continue;
    const bodyStart = open.lastIndex;
    if (bodyStart < scannedTo) continue;
    const bodyEnd = navBodyEnd(pageHtml, bodyStart);
    collectActionLinks(pageHtml.slice(bodyStart, bodyEnd), links);
    scannedTo = bodyEnd;
  }
  return links;
}

/**
 * Merge card links with detail-page nav links. The card wins where both have a
 * label: it is the listing's own call to action, and it is what the scraper has
 * always persisted. The nav only fills gaps.
 *
 * Both halves come from the same scrape, so the result still describes what the
 * site says *today* — which the `action_links` contract depends on (see the
 * note on `source_details.action_links` in LinuxFoundationEventsScraper).
 */
export function mergeActionLinks(cardLinks, navLinks) {
  return { ...(navLinks || {}), ...(cardLinks || {}) };
}

/**
 * The event's sched.com programme host, e.g. `agntconmcpconeu26.sched.com`, or
 * null when the page does not reference one (an event whose programme is not on
 * sched.com, or one that has not published a schedule yet).
 *
 * Checked on 2026-10-10 against five AAIF events: every event that has a sched
 * programme at all references it on its own detail page, so this needs no extra
 * fetch. The schedule page carries the same host and nothing more.
 */
export function extractSchedHost(html) {
  if (!html || html.length > MAX_PARSE_BYTES) return null;
  SCHED_HOST_RE.lastIndex = 0;
  for (const m of html.matchAll(SCHED_HOST_RE)) {
    const sub = m[1].toLowerCase();
    if (SCHED_RESERVED_SUBDOMAINS.has(sub)) continue;
    return `${sub}.sched.com`;
  }
  return null;
}

/**
 * The `source_details.schedule_source` value the event-agenda importer reads to
 * skip its own detect() fetch (spec-event-agenda-schedule-import §5.2, §8.4).
 * Null when no host was found, so the importer falls back to resolving the
 * source itself rather than trusting a stale value.
 */
export function buildScheduleSource(host) {
  if (!host) return null;
  return {
    kind: 'sched',
    host,
    url: `https://${host}/`,
    resolved_from: 'lf_event_page',
  };
}
