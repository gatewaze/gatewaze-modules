/**
 * AaifVirtualEventsScraper — Agentic AI Foundation (AAIF) virtual events on
 * the MLOps Community hub at home.mlops.community/public/events.
 *
 * The hub is a Next.js app (the "Gradual"/MLOps Community events platform).
 * The listing page ships the full event set as structured JSON inside the
 * `<script id="__NEXT_DATA__">` blob — `props.pageProps.events` is an array
 * of card objects (id, slug, name, startedAt/endedAt, timezone, isOnline,
 * cover URLs, registrationUrl). We parse that JSON rather than scraping the
 * rendered HTML — it's the same data the page renders from, and far more
 * robust than card-markup regex.
 *
 * Per-event enrichment: the listing card has no description or tags, so for
 * each future event we drill into its detail page
 * (`/public/events/<slug>`) and pull `props.pageProps.event.description`
 * (HTML body), `tags` (topics), and `liveMeetupInfo.posterUrl` (cover).
 * Best-effort — a failed detail fetch still saves the card-level fields.
 *
 * These are all virtual/online community events, so isVirtual is forced true
 * (matches every card's `isOnline: true`).
 *
 * Three collection modes (config):
 *   - default: future-only from the SSR listing (an "upcoming" surface).
 *   - `include_past: true`: also keep the past events the SSR listing carries
 *     (a rolling ~30-item window).
 *   - `backfill_all: true`: drive a real browser and click "Load more" until the
 *     archive is exhausted — the COMPLETE history (verified back to the
 *     community's first event, Feb 2022). Implies include_past. See
 *     _collectEventsViaBrowser. `startedAt`/`endedAt` are ISO8601 UTC (Zulu).
 *
 * Fetch path: prefers the scrapling-fetcher service when configured, falls
 * back transparently to node-fetch (same content) — same pattern as
 * LinuxFoundationEventsScraper.
 *
 * Verified shape (July 2026):
 *   props.pageProps.events[]:
 *     { id, slug, name, eventType, isOnline, startedAt, endedAt, timezone,
 *       webCoverImageUrl, liveMeetupInfo: { posterUrl }, registrationUrl,
 *       onlineUrl, location }
 *   props.pageProps.event (detail):
 *     { ...same..., description (HTML), tags: [{name}], topics: [] }
 */

import { BaseScraper } from './BaseScraper.js';
import {
  fetchPage,
  ScraplingNotConfiguredError,
} from '../lib/scrapling-fetcher.js';

const SITE_ORIGIN = 'https://home.mlops.community';
const MAX_DESCRIPTION = 20_000;
const MAX_PAGE_CONTENT = 40_000;

// The MLOps Community detail page's `event.description` is already a clean
// rich-text HTML body (paragraphs, lists, links). Reduce it to lean,
// portal-safe HTML for events.page_content: the portal re-sanitises with
// DOMPurify (which has no <table> allow-list and strips lazy-loaded imgs), so
// convert any tables to paragraphs and drop <img> tags (kept links keep the
// media reachable at the source). Cap the length as a guard.
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

function cleanDescriptionHtml(html) {
  if (!html) return '';
  let out = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');
  out = tablesToParagraphs(out);
  out = out.replace(/<img\b[^>]*>/gi, '');
  out = out.trim();
  if (out.length > MAX_PAGE_CONTENT) out = out.slice(0, MAX_PAGE_CONTENT);
  return out;
}

// Decode HTML entities — named, decimal (&#39;) AND hex (&#x27;). Scraped pages
// mix all three; handling only named+decimal leaked raw hex entities into text.
function decodeHtmlEntities(input) {
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

function stripTags(html) {
  if (!html) return '';
  return decodeHtmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

// Pull and parse the Next.js data blob from a fetched HTML page.
// Returns the parsed object, or null when absent/unparseable.
function extractNextData(html) {
  if (!html) return null;
  const m = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export class AaifVirtualEventsScraper extends BaseScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    // Pure HTTP — no browser needed.
    this.config.headless = true;
  }

  // BaseScraper.initialize()/cleanup() launch/close Puppeteer; not needed here.
  async initialize() {}
  async cleanup() {}

  /**
   * Fetch a URL as raw HTML — via scrapling-fetcher when configured, else
   * node-fetch. Pure; the caller extracts __NEXT_DATA__ from the result.
   */
  async _fetchHtml(url) {
    try {
      const result = await fetchPage(url, {
        mode: 'fast',
        extractNextData: false,
        timeoutMs: 15000,
      });
      if (result.status >= 400) {
        throw new Error(`upstream ${result.status} for ${url}`);
      }
      return result.html;
    } catch (err) {
      if (err instanceof ScraplingNotConfiguredError) {
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; GatewazeBot/1.0; +https://example.com)',
            Accept: 'text/html,application/xhtml+xml',
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
   * Drill into an event's detail page for the rich fields the listing card
   * lacks: full HTML description, tags (topics), and the poster/cover image.
   * Best-effort — any failure returns {} so the card-level row still saves.
   */
  async _enrichFromDetailPage(eventLink) {
    let html;
    try {
      html = await this._fetchHtml(eventLink);
    } catch (err) {
      console.warn(`⚠️ detail fetch failed for ${eventLink}: ${err.message}`);
      return {};
    }

    const nextData = extractNextData(html);
    const ev = nextData?.props?.pageProps?.event;
    if (!ev || typeof ev !== 'object') return {};

    const enrich = {};

    if (ev.description) {
      let desc = stripTags(ev.description);
      if (desc.length > MAX_DESCRIPTION) desc = desc.slice(0, MAX_DESCRIPTION);
      if (desc.length > 20) {
        enrich.eventDescription = desc;
        // Full HTML body → events.page_content (first in the portal's
        // content-render priority). Without this the event detail page renders
        // blank even though we captured the description.
        const bodyHtml = cleanDescriptionHtml(ev.description);
        if (bodyHtml.length > 20) enrich.pageContentHtml = bodyHtml;
      }
    }

    const tags = Array.isArray(ev.tags)
      ? ev.tags.map((t) => t?.name).filter(Boolean)
      : [];
    const topics = Array.isArray(ev.topics)
      ? ev.topics.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
      : [];
    const allTopics = [...new Set([...topics, ...tags])];
    if (allTopics.length) enrich.eventTopics = allTopics;

    const cover = ev.liveMeetupInfo?.posterUrl || ev.webCoverImageUrl || null;
    if (cover) enrich.coverImageUrl = cover;

    return enrich;
  }

  /**
   * Full archive via a real browser. The SSR listing (__NEXT_DATA__) is only a
   * ~30-item window; the rest loads through a "Load more" button that fires a
   * GraphQL `pastMeetups(skip)` query. That endpoint is persisted-query
   * safelisted AND bot-protected, so server-side POSTs (even from inside the
   * page) get 403 — we can't replicate the request. Instead we drive the real
   * page: intercept every /api/graphql response, then click "Load more" until
   * it disappears. Seeds the initial/upcoming set from __NEXT_DATA__ too.
   * Verified: reaches the full archive back to the community's first event.
   * Returns card-shaped events deduped by id — the shape scrape() expects.
   */
  async _collectEventsViaBrowser(baseUrl) {
    const cfg = this.config?.config || {};
    const maxClicks = Number(cfg.max_load_more_clicks) || 100;
    const noBtnLimit = Number(cfg.load_more_miss_limit) || 15;
    const loadWaitMs = Number(cfg.load_more_wait_ms) || 2600;

    const puppeteer = (await import('puppeteer-core')).default;
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check',
      ],
      ignoreHTTPSErrors: true,
      timeout: 120000,
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      const byId = new Map();
      const add = (x) => { if (x && x.id && x.slug && x.startedAt) byId.set(x.id, x); };
      const scan = (o) => {
        if (Array.isArray(o)) { for (const x of o) add(x); }
        else if (o && typeof o === 'object') { for (const v of Object.values(o)) scan(v); }
      };
      // Each "Load more" click fires a GraphQL query — capture every event in
      // those responses (query-agnostic: upcoming + past).
      page.on('response', async (res) => {
        try {
          if (!res.url().includes('/api/graphql')) return;
          const j = await res.json().catch(() => null);
          if (j) scan(j.data || j);
        } catch { /* ignore malformed/binary responses */ }
      });

      await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise((r) => setTimeout(r, 2000));
      // Seed with the SSR set (initial + any upcoming events, rendered from
      // __NEXT_DATA__ rather than an XHR the interceptor sees).
      try {
        const nd = extractNextData(await page.content());
        for (const e of nd?.props?.pageProps?.events || []) add(e);
      } catch { /* best effort */ }

      // Click "Load more" until it's gone (disabled = mid-load, wait; absent for
      // noBtnLimit consecutive checks = archive exhausted).
      let clicks = 0;
      let noBtn = 0;
      for (let i = 0; i < maxClicks + noBtnLimit + 20 && clicks < maxClicks && noBtn < noBtnLimit; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise((r) => setTimeout(r, 600));
        const state = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find((e) => /load more/i.test(e.textContent || ''));
          if (!btn) return 'none';
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return 'wait';
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return 'clicked';
        });
        if (state === 'clicked') { clicks++; noBtn = 0; await new Promise((r) => setTimeout(r, loadWaitMs)); }
        else if (state === 'wait') { await new Promise((r) => setTimeout(r, 1500)); }
        else { noBtn++; await new Promise((r) => setTimeout(r, 900)); }
      }
      console.log(`🌐 Browser backfill: ${clicks} "Load more" clicks → ${byId.size} events`);
      return [...byId.values()];
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async scrape() {
    const baseUrl =
      this.config.url ||
      this.config.base_url ||
      `${SITE_ORIGIN}/public/events`;

    // `backfill_all: true` drives a real browser + "Load more" to pull the ENTIRE
    // archive (the SSR listing alone is a ~30-item window). It implies
    // include_past. Otherwise we parse the SSR __NEXT_DATA__ listing.
    const cfg = this.config?.config || {};
    const backfillAll = cfg.backfill_all === true || this.config?.backfill_all === true;

    console.log(`🎯 AaifVirtualEventsScraper fetching: ${baseUrl}`);
    let events;
    if (backfillAll) {
      console.log('🌐 backfill_all enabled — driving a real browser to load the full archive');
      events = await this._collectEventsViaBrowser(baseUrl);
    } else {
      const html = await this._fetchHtml(baseUrl);
      console.log(`📥 Fetched ${html.length} bytes`);
      const nextData = extractNextData(html);
      events = nextData?.props?.pageProps?.events;
      if (!Array.isArray(events)) {
        throw new Error(
          'AaifVirtualEventsScraper: could not find props.pageProps.events in __NEXT_DATA__ (page structure changed?)',
        );
      }
    }
    console.log(`🔎 ${events.length} events collected (pre-filter)`);

    // Init stats so the summary log doesn't print NaN.
    if (typeof this.stats.found !== 'number') this.stats.found = 0;
    if (typeof this.stats.processed !== 'number') this.stats.processed = 0;
    if (typeof this.stats.skipped !== 'number') this.stats.skipped = 0;
    if (typeof this.stats.failed !== 'number') this.stats.failed = 0;

    const streamingSave = typeof this.globalConfig?.saveEvent === 'function';
    if (streamingSave) {
      console.log('💾 Streaming mode: events will be saved as they are parsed');
    }

    const now = Date.now();
    // By default this is an "upcoming" surface (future-only). Set the scraper's
    // config `include_past: true` to also backfill past events — the listing
    // still ships them (a rolling window the source caps at ~30 items).
    const includePast =
      backfillAll ||
      this.config?.config?.include_past === true || this.config?.include_past === true;
    if (includePast) console.log('🕰️  including past events');

    for (const card of events) {
      try {
        const id = card?.id;
        const slug = card?.slug;
        const eventTitle = (card?.name || '').trim();
        if (!id || !slug || !eventTitle) {
          this.stats.failed++;
          continue;
        }

        const eventStart = card.startedAt || null;
        const eventEnd = card.endedAt || null;

        // Skip events with no valid start date; skip past events only when the
        // scraper is in the default future-only mode (see `includePast` above).
        const startMs = eventStart ? Date.parse(eventStart) : NaN;
        if (Number.isNaN(startMs)) {
          this.stats.skipped++;
          continue;
        }
        if (!includePast && startMs < now) {
          this.stats.skipped++;
          continue;
        }

        const eventLink = `${SITE_ORIGIN}/public/events/${slug}`;
        const cardCover =
          card.liveMeetupInfo?.posterUrl || card.webCoverImageUrl || null;

        // Enrich from the detail page for description + tags + best cover.
        const enrich = await this._enrichFromDetailPage(eventLink);

        const coverImageUrl = enrich.coverImageUrl || cardCover || null;

        const event = {
          eventTitle,
          eventLink,
          eventStart,
          eventEnd,
          eventCity: '',
          eventCountryCode: '',
          eventRegion: '',
          eventLocation: '',
          eventTimezone: card.timezone || 'UTC',
          // These are all online/virtual sessions. Use the brand's configured
          // 'virtual' event type (Settings → Event types) so the portal shows a
          // real type label rather than an unconfigured 'webinar' string.
          // Overridable per-scraper via config.event_type.
          eventType: this.config.event_type || 'virtual',
          eventTopics: enrich.eventTopics || [],
          listingIntro: '',
          eventDescription: enrich.eventDescription || '',
          // Full page-body HTML from the detail page → events.page_content
          // (dedicated field the handler writes directly; see scraper-job-handler).
          pageContentHtml: enrich.pageContentHtml || null,
          coverImageUrl,
          eventLogo: coverImageUrl,
          eventFeaturedImage: coverImageUrl,
          isVirtual: true,
          enableRegistration: !!(card.registrationUrl || card.onlineUrl),
          enableNativeRegistration: false,
          scraperName: this.config.name || 'aaif-virtual-events',
          sourceEventId: `aaif-virtual-${id}`,
          sourceType: 'mlops-community',
          sourceDetails: {
            mlops_event_id: id,
            slug,
            event_type: card.displayEventType || card.eventType || null,
            timezone: card.timezone || null,
            is_online: card.isOnline !== false,
            registration_url: card.registrationUrl || null,
            online_url: card.onlineUrl || null,
            watch_on_demand_url: card.watchOnDemandUrl || null,
            raw_start: eventStart,
            raw_end: eventEnd,
          },
        };

        this.stats.found++;

        if (streamingSave) {
          try {
            await this.globalConfig.saveEvent(event);
            this.stats.processed++;
          } catch (saveErr) {
            console.warn(
              `⚠️ Streaming save failed for "${event.eventTitle}": ${saveErr.message}`,
            );
            this.scrapedEvents.push(event);
          }
        } else {
          this.scrapedEvents.push(event);
        }
      } catch (cardErr) {
        console.warn(`⚠️ Failed to parse event card: ${cardErr.message}`);
        this.stats.failed++;
      }
    }

    console.log(
      `✅ AaifVirtualEventsScraper finished: ${this.stats.found} found${includePast ? ' (incl. past)' : ' (future only)'}, ${this.stats.processed} processed, ${this.stats.skipped} skipped, ${this.stats.failed} failed`,
    );
    return this.scrapedEvents;
  }
}
