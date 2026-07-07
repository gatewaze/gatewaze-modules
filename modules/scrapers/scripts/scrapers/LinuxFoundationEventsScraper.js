/**
 * LinuxFoundationEventsScraper — events.linuxfoundation.org listing scraper.
 *
 * Server-rendered WordPress site. The listing page yields card metadata
 * (title, dates, location, action-button URLs) without per-event drill-in,
 * AND each event's detail page carries a Schema.org `Event` JSON-LD plus
 * `og:` meta tags that fill in the longer description, venue address,
 * region, and large cover image. The scraper does both — listing for the
 * fast-path basics, then per-event drill for the rich enrichment fields
 * downstream features (portal listing, member newsletter) need.
 *
 * Fetch path: routes through the scrapling-fetcher service when
 * `SCRAPLING_FETCHER_URL` is set (which it is in any environment that
 * has the spec-scrapling-fetcher-service deployment turned on). Falls
 * back transparently to plain node-fetch when not configured — no
 * functional change, just no per-fetch cost-ledger row.
 *
 * Filter support: the operator passes the listing URL with whatever
 * query string they want (e.g., `?_sft_lfevent-category=agentic-ai-foundation-events`).
 * We just fetch that URL verbatim — the WordPress "Search & Filter"
 * plugin handles the filtering server-side.
 *
 * Card structure (verified May 2026):
 *   <div id="post-NNNN" class="cell ... event callout">
 *     <h2 class="event-title"><a href="...event-slug/">Title</a></h2>
 *     <p class="event-meta">
 *       <span class="date">Jun 9–10, 2026</span>
 *       <span class="country">Bengaluru, India</span>
 *     </p>
 *     <div class="event-description"><p>...</p></div>
 *     <a href="..../register/">Register</a>
 *     <a href="..../sponsor/">Sponsor</a>
 *     <a href="..../program/schedule/">Schedule</a>
 *     <a href="https://youtube.com/...">Videos</a>
 *     <a href="..../speak/">Speak</a>          (only some events)
 *   </div>
 *
 * Action-button URLs are persisted into source_details.action_links so
 * downstream features can use them without re-scraping.
 */

import { BaseScraper } from './BaseScraper.js';
import {
  fetchPage,
  ScraplingNotConfiguredError,
} from '../lib/scrapling-fetcher.js';


// Each card's <h2> link → primary event URL. The action buttons that
// follow are matched by their visible text (Register / Sponsor / etc.).
const CARD_BLOCK_RE = /<div id="post-(\d+)"\s+class="[^"]*\bevent\b[^"]*"[^>]*>([\s\S]+?)(?=<div id="post-\d+"|<footer|<div class="pagination)/g;
const TITLE_RE = /<h2[^>]*class="[^"]*event-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]+?)<\/a>/;
const DATE_RE = /<span[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]+?)<\/span>/;
const COUNTRY_RE = /<span[^>]*class="[^"]*\bcountry\b[^"]*"[^>]*>([\s\S]+?)<\/span>/;
const DESC_RE = /<div[^>]*class="[^"]*\bevent-description\b[^"]*"[^>]*>([\s\S]+?)<\/div>/;
const ANCHOR_RE = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]+?)<\/a>/g;

const ACTION_BUTTON_LABELS = new Set([
  'register', 'sponsor', 'schedule', 'videos', 'speak',
  // Less common but observed:
  'attend', 'sponsorships', 'agenda', 'program', 'tickets',
]);


// ISO 3166-1 alpha-2 country code mapping for the country names LF uses.
// Lower-case (events.event_country_code is lower-case 2-letter per the
// existing scraper convention). Unknown countries fall through as ''.
const COUNTRY_NAME_TO_CODE = {
  'united states': 'us', 'usa': 'us', 'us': 'us',
  'united kingdom': 'gb', 'uk': 'gb', 'great britain': 'gb',
  'india': 'in', 'china': 'cn', 'japan': 'jp', 'korea': 'kr',
  'south korea': 'kr', 'germany': 'de', 'france': 'fr', 'spain': 'es',
  'italy': 'it', 'netherlands': 'nl', 'sweden': 'se', 'norway': 'no',
  'denmark': 'dk', 'finland': 'fi', 'ireland': 'ie', 'belgium': 'be',
  'switzerland': 'ch', 'austria': 'at', 'poland': 'pl', 'portugal': 'pt',
  'canada': 'ca', 'mexico': 'mx', 'brazil': 'br', 'argentina': 'ar',
  'australia': 'au', 'new zealand': 'nz', 'singapore': 'sg',
  'thailand': 'th', 'indonesia': 'id', 'vietnam': 'vn', 'malaysia': 'my',
  'philippines': 'ph', 'taiwan': 'tw', 'hong kong': 'hk',
  'south africa': 'za', 'nigeria': 'ng', 'kenya': 'ke', 'egypt': 'eg',
  'uae': 'ae', 'united arab emirates': 'ae', 'israel': 'il', 'turkey': 'tr',
};


function stripTags(html) {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}


// LF event pages are WordPress; the full event body lives in a single
// `<div class="entry-content">`. Pull its inner HTML by depth-matching the
// opening div to its closing tag (regex alone can't handle the nested
// page-builder divs). Returns null when the container isn't present.
function extractEntryContentHtml(html) {
  const open = html.match(/<div[^>]*class="[^"]*\bentry-content\b[^"]*"[^>]*>/);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 1;
  for (const tag of html.slice(start).matchAll(/<(\/?)div\b[^>]*>/g)) {
    depth += tag[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, start + tag.index);
  }
  return null;
}

// Remove whole elements (depth-matched <div>) whose opening tag matches `re`.
// Used to drop interactive widgets whose JS never runs on the portal (e.g. the
// "Ultimate Blocks" countdown timer), which would otherwise render as dead
// markup / stray numbers + "Weeks Days Hours…" labels.
function stripBlocks(html, re) {
  let out = html;
  for (let i = 0; i < 20; i++) {
    const open = out.match(re);
    if (!open) break;
    const afterOpen = open.index + open[0].length;
    let depth = 1;
    let end = out.length;
    for (const t of out.slice(afterOpen).matchAll(/<(\/?)div\b[^>]*>/g)) {
      depth += t[1] === '/' ? -1 : 1;
      if (depth === 0) { end = afterOpen + t.index + t[0].length; break; }
    }
    out = out.slice(0, open.index) + out.slice(end);
  }
  return out;
}

// The LF schedule is a <table> ("Schedule at a glance"), but the portal's
// sanitizer allow-list has no table tags, so it collapses each row's cells
// into run-together text. Convert every row to a paragraph the portal renders
// cleanly: "<strong>Day</strong> — session summary".
function tablesToParagraphs(html) {
  return html.replace(/<table\b[\s\S]*?<\/table>/gi, (tbl) => {
    const rows = [...tbl.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    return rows
      .map((r) => {
        const cells = [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1].trim());
        if (cells.length === 0) return '';
        if (cells.length === 1) return `<p>${cells[0]}</p>`;
        return `<p>${cells[0]} — ${cells.slice(1).join(' ')}</p>`;
      })
      .join('');
  });
}

// Reduce a raw LF event-page body to lean, portal-safe HTML: just the
// descriptive prose, a readable "Schedule at a glance", and the real links
// (session recordings, livestreams). Everything that doesn't survive / doesn't
// belong on the portal is dropped — the hero cover (its own image + date +
// venue + Register/Sponsor buttons + hashtags), the countdown widget, layout
// spacers, and every <img> (LF lazy-loads them via srcset/data-src, which the
// portal sanitizer strips, so they'd render broken). Links stay so the media
// remains reachable on the LF/YouTube source. The portal DOMPurifies again.
const MAX_PAGE_CONTENT = 120_000;
function cleanContentHtml(html) {
  if (!html) return '';
  let out = html;
  // 1. Drop whole junk blocks (depth-matched divs).
  out = stripBlocks(out, /<div[^>]*class="[^"]*\bwp-block-cover\b[^"]*"[^>]*>/i);   // hero: image/date/venue/register+sponsor
  out = stripBlocks(out, /<div[^>]*class="[^"]*\bub[-_]countdown\b[^"]*"[^>]*>/i);  // countdown timer
  out = stripBlocks(out, /<div[^>]*class="[^"]*\bwp-block-spacer\b[^"]*"[^>]*>/i);  // layout spacers
  // 2. Schedule table → readable paragraphs.
  out = tablesToParagraphs(out);
  // 3. Drop media that breaks on the portal + the now-empty wrappers; keep
  //    real links. Also drop stray Register/Sponsor buttons outside the hero.
  out = out
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<a\b[^>]*>\s*(?:Register|Sponsor)\s*<\/a>/gi, '')
    .replace(/<a\b[^>]*>\s*<\/a>/gi, '')
    .replace(/<figure\b[^>]*>\s*<\/figure>/gi, '');
  // 4. Strip scripts/styles/svg/etc + inline handlers + data-* noise.
  out = out
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\son[a-z]+="[^"]*"/gi, '')
    .replace(/\sdata-[\w-]+="[^"]*"/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > MAX_PAGE_CONTENT) out = out.slice(0, MAX_PAGE_CONTENT);
  return out;
}


/**
 * Parse the LF date strings into ISO8601. Handles:
 *   "Jun 9–10, 2026"      → start=2026-06-09, end=2026-06-10
 *   "Jul 28 – Aug 1, 2026" → start=2026-07-28, end=2026-08-01
 *   "September 17, 2026"   → start=end=2026-09-17
 * Returns { eventStart, eventEnd } in YYYY-MM-DDT00:00:00Z form, or
 * { null, null } when unparseable (the row still gets saved with the
 * raw date in source_details.raw_date for manual investigation).
 */
function parseLfDate(dateText) {
  if (!dateText) return { eventStart: null, eventEnd: null };
  // Normalise dashes (en-dash, em-dash, hyphen-minus) → ' - '
  const normalised = dateText.replace(/[–—]/g, '-').replace(/\s*-\s*/g, ' - ');
  // Try matching the four common shapes:
  //   "Mon D - D, YYYY"
  //   "Mon D - Mon D, YYYY"
  //   "Mon D, YYYY"
  const monthShortToNum = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const monthFull = {
    january: 1, february: 2, march: 3, april: 4,
    july: 7, august: 8, september: 9, october: 10,
    november: 11, december: 12, june: 6, may: 5,
  };
  const lookupMonth = (name) => {
    const n = name.toLowerCase().slice(0, 3);
    return monthFull[name.toLowerCase()] ?? monthShortToNum[n] ?? null;
  };

  // Split off the year (assume it's the last 4-digit token)
  const yearMatch = normalised.match(/(\d{4})/);
  if (!yearMatch) return { eventStart: null, eventEnd: null };
  const year = parseInt(yearMatch[1], 10);
  const beforeYear = normalised.slice(0, yearMatch.index).replace(/,/g, '').trim();

  // Tokenise: ["Jun", "9", "-", "10"] or ["Jul", "28", "-", "Aug", "1"] or ["September", "17"]
  const tokens = beforeYear.split(/\s+/).filter(Boolean);

  let startMonth = null, startDay = null, endMonth = null, endDay = null;

  if (tokens.length === 2) {
    // "September 17"
    startMonth = lookupMonth(tokens[0]);
    startDay = parseInt(tokens[1], 10);
    endMonth = startMonth;
    endDay = startDay;
  } else if (tokens.length === 4 && tokens[2] === '-') {
    // "Jun 9 - 10"
    startMonth = lookupMonth(tokens[0]);
    startDay = parseInt(tokens[1], 10);
    endMonth = startMonth;
    endDay = parseInt(tokens[3], 10);
  } else if (tokens.length === 5 && tokens[2] === '-') {
    // "Jul 28 - Aug 1"
    startMonth = lookupMonth(tokens[0]);
    startDay = parseInt(tokens[1], 10);
    endMonth = lookupMonth(tokens[3]);
    endDay = parseInt(tokens[4], 10);
  }

  if (!startMonth || !startDay) return { eventStart: null, eventEnd: null };

  const pad = (n) => String(n).padStart(2, '0');
  const eventStart = `${year}-${pad(startMonth)}-${pad(startDay)}T00:00:00Z`;
  const eventEnd = `${year}-${pad(endMonth || startMonth)}-${pad(endDay || startDay)}T00:00:00Z`;
  return { eventStart, eventEnd };
}


/**
 * Split "Bengaluru, India" → { city: "Bengaluru", country: "India" }.
 * LF events list location as "City, Country" (or sometimes just country
 * for virtual / globally-distributed events). Country code mapping is
 * left to GeocodingService downstream — we just record the country name.
 */
function parseLocation(locText) {
  if (!locText) return { city: '', country: '' };
  const parts = locText.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { city: parts[0], country: parts[parts.length - 1] };
  }
  return { city: '', country: parts[0] || '' };
}


function extractActionLinks(cardHtml) {
  const links = {};
  let m;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(cardHtml)) !== null) {
    const href = m[1];
    const text = stripTags(m[2]).toLowerCase();
    if (!text) continue;
    if (ACTION_BUTTON_LABELS.has(text)) {
      // First occurrence wins; subsequent matches with the same label
      // (rare but possible) are ignored to keep the shape predictable.
      if (!(text in links)) links[text] = href;
    }
  }
  return links;
}


export class LinuxFoundationEventsScraper extends BaseScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    // No browser — override BaseScraper's headless setting noise.
    this.config.headless = true;
  }

  // BaseScraper.initialize() launches Puppeteer; we don't need it.
  async initialize() {
    // no-op
  }

  // BaseScraper.cleanup() closes the browser; we don't need it either.
  async cleanup() {
    // no-op
  }

  /**
   * Fetch a URL — preferring the scrapling-fetcher service (same pattern
   * as the Luma *Fast scraper variants), falling back to plain node-fetch
   * when the service isn't configured for this environment.
   *
   * Returns the raw HTML string. The caller decides what to do with it
   * (regex out cards, parse JSON-LD, etc.) — keeping this method pure
   * so it can be reused for both listing and detail fetches.
   */
  async _fetchHtml(url) {
    try {
      const result = await fetchPage(url, {
        mode: 'fast',
        extractNextData: false, // LF doesn't use Next.js
        timeoutMs: 15000,
      });
      if (result.status >= 400) {
        throw new Error(`upstream ${result.status} for ${url}`);
      }
      return result.html;
    } catch (err) {
      // Service not deployed? Fall back to direct fetch — same content.
      if (err instanceof ScraplingNotConfiguredError) {
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; GatewazeBot/1.0; +https://example.com)',
            'Accept': 'text/html,application/xhtml+xml',
          },
          redirect: 'follow',
        });
        if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
        return await res.text();
      }
      throw err;
    }
  }

  /**
   * Drill into a single event's detail page and pull the enriched fields:
   *   - Schema.org Event JSON-LD: longer description, venue address,
   *     region, image (cover URL)
   *   - og:image (typically larger than the JSON-LD image), og:description
   *
   * Best-effort: any failure (network, parse) returns {} so the listing
   * row still saves with the basic card fields. Cost-ledger row only
   * fires when scrapling-fetcher handles the call.
   */
  async _enrichFromDetailPage(eventLink) {
    let html;
    try {
      html = await this._fetchHtml(eventLink);
    } catch (err) {
      console.warn(`⚠️ detail fetch failed for ${eventLink}: ${err.message}`);
      return {};
    }

    const enrich = {};

    // Schema.org Event JSON-LD — the canonical source for venue + date
    const jsonLdMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g);
    for (const m of jsonLdMatches) {
      let parsed;
      try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
      const events = Array.isArray(parsed) ? parsed
        : parsed['@graph'] ? parsed['@graph'].filter((x) => x['@type'] === 'Event')
        : parsed['@type'] === 'Event' ? [parsed]
        : [];
      const eventLd = events[0];
      if (!eventLd) continue;

      // Tighten dates if the JSON-LD has them (typically same as card)
      if (eventLd.startDate) enrich.eventStart = eventLd.startDate.includes('T') ? eventLd.startDate : `${eventLd.startDate}T00:00:00Z`;
      if (eventLd.endDate)   enrich.eventEnd   = eventLd.endDate.includes('T')   ? eventLd.endDate   : `${eventLd.endDate}T00:00:00Z`;

      const loc = Array.isArray(eventLd.location) ? eventLd.location[0] : eventLd.location;
      if (loc?.address) {
        const a = loc.address;
        const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
          .map((s) => (s ?? '').trim())
          .filter(Boolean);
        if (parts.length > 0) enrich.venueAddress = parts.join(', ');
        if (a.addressRegion) enrich.eventRegion = a.addressRegion;
        if (a.addressCountry && !enrich.eventCountryCode) {
          const code = COUNTRY_NAME_TO_CODE[a.addressCountry.toLowerCase()];
          if (code) enrich.eventCountryCode = code;
        }
        if (a.addressLocality) enrich.eventCity = a.addressLocality;
      }
      if (loc?.name) enrich.venueName = loc.name;

      // event_logo / event_featured_image / coverImageUrl all map to a URL
      const image = Array.isArray(eventLd.image) ? eventLd.image[0] : eventLd.image;
      if (image && typeof image === 'string') {
        enrich.eventLogo = image;
        enrich.coverImageUrl = image;
      }

      if (eventLd.eventAttendanceMode) {
        if (String(eventLd.eventAttendanceMode).includes('Online')) enrich.isVirtual = true;
        else if (String(eventLd.eventAttendanceMode).includes('Mixed')) enrich.isHybrid = true;
      }

      if (eventLd.description && eventLd.description.length > 50) {
        // Decode HTML entities the description-text frequently contains
        enrich.eventDescriptionLong = stripTags(eventLd.description);
      }
      break; // first Event JSON-LD wins
    }

    // og: meta — typically the highest-quality cover image + a clean description
    const ogTagRe = /<meta[^>]*property="og:([^"]+)"[^>]*content="([^"]*)"/g;
    const og = {};
    for (const m of html.matchAll(ogTagRe)) og[m[1]] = m[2];
    if (og.image && !enrich.eventLogo) enrich.eventLogo = og.image;
    if (og.image && !enrich.coverImageUrl) enrich.coverImageUrl = og.image;
    // og:image is often larger than the JSON-LD image — prefer it for cover
    if (og.image) enrich.coverImageUrl = og.image;
    if (og.description && (!enrich.eventDescriptionLong || og.description.length > enrich.eventDescriptionLong.length)) {
      enrich.eventDescriptionLong = og.description.replace(/&amp;/g, '&').replace(/&#039;/g, "'");
    }

    // Full event-page body → rendered on the portal detail page. Stored in
    // events.page_content (first in the portal's content priority) via a
    // dedicated `pageContentHtml` field so it never collides with the Luma
    // scraper's raw-text `pageContent`. Also feeds speaker/agenda extraction.
    const bodyHtml = cleanContentHtml(extractEntryContentHtml(html) || '');
    if (bodyHtml && bodyHtml.length > 200) {
      enrich.pageContentHtml = bodyHtml;
    }

    return enrich;
  }

  async scrape() {
    const baseUrl = this.config.url || this.config.base_url;
    if (!baseUrl) {
      throw new Error('LinuxFoundationEventsScraper requires base_url (the listing-page URL, optionally with ?_sft_... filter)');
    }

    console.log(`🎯 LinuxFoundationEventsScraper fetching: ${baseUrl}`);
    const html = await this._fetchHtml(baseUrl);
    console.log(`📥 Fetched ${html.length} bytes`);

    // Initialise stats so the summary log doesn't print NaN.
    if (typeof this.stats.found !== 'number') this.stats.found = 0;
    if (typeof this.stats.processed !== 'number') this.stats.processed = 0;
    if (typeof this.stats.skipped !== 'number') this.stats.skipped = 0;
    if (typeof this.stats.failed !== 'number') this.stats.failed = 0;

    const streamingSave = typeof this.globalConfig?.saveEvent === 'function';
    if (streamingSave) {
      console.log('💾 Streaming mode: events will be saved as they are parsed');
    }

    let cardMatch;
    CARD_BLOCK_RE.lastIndex = 0;
    while ((cardMatch = CARD_BLOCK_RE.exec(html)) !== null) {
      const postId = cardMatch[1];
      const cardHtml = cardMatch[2];

      try {
        const titleMatch = cardHtml.match(TITLE_RE);
        if (!titleMatch) {
          this.stats.failed++;
          continue;
        }
        const eventLink = titleMatch[1];
        const eventTitle = stripTags(titleMatch[2]);

        const dateMatch = cardHtml.match(DATE_RE);
        const dateText = dateMatch ? stripTags(dateMatch[1]) : '';
        const { eventStart, eventEnd } = parseLfDate(dateText);

        const countryMatch = cardHtml.match(COUNTRY_RE);
        const locText = countryMatch ? stripTags(countryMatch[1]) : '';
        const { city, country } = parseLocation(locText);

        const descMatch = cardHtml.match(DESC_RE);
        const description = descMatch ? stripTags(descMatch[1]) : '';

        const actionLinks = extractActionLinks(cardHtml);

        // Drill into the detail page for the rich fields the events
        // module supports (venue address, full description, large cover
        // image, region, etc). Per-page fetch goes through scrapling-
        // fetcher when configured — same path as the Luma *Fast scrapers.
        const enrich = await this._enrichFromDetailPage(eventLink);

        const countryCode =
          enrich.eventCountryCode
          || COUNTRY_NAME_TO_CODE[country.toLowerCase()]
          || '';

        const event = {
          eventTitle,
          eventLink,
          eventStart: enrich.eventStart || eventStart,
          eventEnd: enrich.eventEnd || eventEnd,
          eventCity: enrich.eventCity || city,
          eventCountryCode: countryCode,
          eventRegion: enrich.eventRegion || '',
          eventLocation: '',
          eventTimezone: 'UTC',
          eventType: 'conference',
          eventTopics: [],
          // listing_intro = the short card description; event_description =
          // the longer JSON-LD/og:description from the detail page when
          // available (falls back to the card text).
          listingIntro: description,
          eventDescription: enrich.eventDescriptionLong || description,
          // Full page-body HTML from the detail page → events.page_content
          // (portal detail render + speaker/agenda extraction input).
          pageContentHtml: enrich.pageContentHtml || null,
          venueAddress: enrich.venueAddress || '',
          eventLogo: enrich.eventLogo || null,
          eventFeaturedImage: enrich.eventLogo || null,
          coverImageUrl: enrich.coverImageUrl || enrich.eventLogo || null,
          isVirtual: !!enrich.isVirtual
            || locText.toLowerCase().includes('virtual')
            || locText.toLowerCase().includes('online'),
          // Action-button presence implies registration is open externally;
          // the events module reads this to surface the Register button on
          // the public page.
          enableRegistration: 'register' in actionLinks,
          enableNativeRegistration: false,
          scraperName: this.config.name || 'linuxfoundation-events',
          sourceEventId: `lf-${postId}`,
          sourceType: 'linuxfoundation',
          sourceDetails: {
            wp_post_id: parseInt(postId, 10),
            raw_date: dateText,
            raw_location: locText,
            raw_country: country,
            venue_name: enrich.venueName || null,
            is_hybrid: !!enrich.isHybrid,
            // Every action button URL on the card, keyed by lower-cased
            // label. CFP / sponsor / video links open + close at different
            // times for each event — the action_links column needs to
            // reflect what's currently on the page, not the union of
            // every button ever observed. The downstream contract that
            // makes this work:
            //   1. scraper-job-handler.js builds dbEvent.source_details
            //      as a fresh object on every save (NOT a deep-merge with
            //      the existing DB row).
            //   2. The events_update RPC does
            //         source_details = COALESCE(p_source_details, source_details)
            //      — full-replace when the param is non-null.
            // If either of those changes to a JSONB || merge, removed
            // buttons (e.g. `speak` after CFP closes) will silently
            // persist. Lock those two assertions before changing.
            action_links: actionLinks,
          },
        };

        if (!event.eventTitle || !event.eventLink) {
          this.stats.failed++;
          continue;
        }

        this.stats.found++;

        if (streamingSave) {
          try {
            await this.globalConfig.saveEvent(event);
            this.stats.processed++;
          } catch (saveErr) {
            console.warn(`⚠️ Streaming save failed for "${event.eventTitle}": ${saveErr.message}`);
            this.scrapedEvents.push(event);
          }
        } else {
          this.scrapedEvents.push(event);
        }
      } catch (cardErr) {
        console.warn(`⚠️ Failed to parse card post-${postId}: ${cardErr.message}`);
        this.stats.failed++;
      }
    }

    console.log(`✅ LinuxFoundationEventsScraper finished: ${this.stats.found} found, ${this.stats.processed} processed, ${this.stats.failed} failed`);
    return this.scrapedEvents;
  }
}
