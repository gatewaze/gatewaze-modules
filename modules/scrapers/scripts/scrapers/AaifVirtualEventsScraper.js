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
 * Future-only: the operator asked for upcoming events only, so any event
 * whose start (startedAt) is in the past is skipped. `startedAt`/`endedAt`
 * are already ISO8601 UTC (Zulu) in the JSON.
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

function stripTags(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
      if (desc.length > 20) enrich.eventDescription = desc;
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

  async scrape() {
    const baseUrl =
      this.config.url ||
      this.config.base_url ||
      `${SITE_ORIGIN}/public/events`;

    console.log(`🎯 AaifVirtualEventsScraper fetching: ${baseUrl}`);
    const html = await this._fetchHtml(baseUrl);
    console.log(`📥 Fetched ${html.length} bytes`);

    const nextData = extractNextData(html);
    const events = nextData?.props?.pageProps?.events;
    if (!Array.isArray(events)) {
      throw new Error(
        'AaifVirtualEventsScraper: could not find props.pageProps.events in __NEXT_DATA__ (page structure changed?)',
      );
    }
    console.log(`🔎 Listing has ${events.length} events (pre-filter)`);

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

        // Future-only: skip anything already started/past.
        const startMs = eventStart ? Date.parse(eventStart) : NaN;
        if (Number.isNaN(startMs) || startMs < now) {
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
          eventType: 'webinar',
          eventTopics: enrich.eventTopics || [],
          listingIntro: '',
          eventDescription: enrich.eventDescription || '',
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
      `✅ AaifVirtualEventsScraper finished: ${this.stats.found} future found, ${this.stats.processed} processed, ${this.stats.skipped} skipped (past), ${this.stats.failed} failed`,
    );
    return this.scrapedEvents;
  }
}
