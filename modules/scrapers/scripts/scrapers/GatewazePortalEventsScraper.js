/**
 * GatewazePortalEventsScraper — copy the public events of another Gatewaze
 * brand into this one, e.g. every event on aaif.live into tech.tickets.
 *
 * Reads the source brand's public JSON API rather than its HTML:
 *   GET <base_url>/api/portal/events?direction=…&limit=1000&offset=N   listing
 *   GET <base_url>/api/portal/events/<event_id>                        detail
 * Both are unauthenticated and CDN-cached. The listing already applies the
 * source brand's publishing rules (live, listed, has a card image), so this
 * brand only receives what the source shows the public, and the source brand
 * keeps running the scrapers that find those events in the first place.
 *
 * Each event goes through the normal save pipeline (globalConfig.saveEvent):
 * dedupe by Luma event id, then source_event_id (`portal:<host>:<event_id>`),
 * then link, then title and date; the source's card image is copied into this
 * brand's storage as the screenshot; the body HTML lands in page_content.
 *
 * Config (scrapers.config):
 *   portal_url           source portal origin for event-page links
 *                        (default: base_url host without "api.")
 *   upcoming_only        true to skip past events (default false: all events)
 *   event_type_mappings  ["sourceType=thisBrandType", …], over the defaults
 *   exclude_event_types  source types to skip, e.g. ["virtual"]
 *   request_delay_ms     pause between detail requests (default 250)
 *   max_events           safety cap per run (default 2000)
 */

import { BaseScraper } from './BaseScraper.js';
import {
  isValidEventId,
  mapPortalEvent,
  parseEventTypeMap,
  resolveSource,
} from '../lib/gatewaze-portal-events.js';

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const MAX_LISTING_BYTES = 20 * 1024 * 1024;
const MAX_DETAIL_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GatewazePortalEventsScraper extends BaseScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    this.config.headless = true;
  }

  // BaseScraper.initialize()/cleanup() launch/close Puppeteer; not needed here.
  async initialize() {}
  async cleanup() {}

  _cfg() {
    return this.config?.config || {};
  }

  async _fetchJson(url, maxBytes) {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GatewazeBot/1.0 (portal-events)',
      },
      // The public API answers directly; a redirect would mean the source
      // moved, and following it blindly could leave the allowed origin.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error(`response too large (${declared} bytes) for ${url}`);
    const text = await res.text();
    if (text.length > maxBytes) throw new Error(`response too large (${text.length} chars) for ${url}`);
    return JSON.parse(text);
  }

  async _listEvents(apiOrigin, direction, maxEvents) {
    const rows = [];
    for (let page = 0; page < MAX_PAGES && rows.length < maxEvents; page++) {
      const offset = page * PAGE_SIZE;
      const url = `${apiOrigin}/api/portal/events?direction=${direction}&limit=${PAGE_SIZE}&offset=${offset}`;
      const body = await this._fetchJson(url, MAX_LISTING_BYTES);
      const data = Array.isArray(body?.data) ? body.data : null;
      if (!data) throw new Error(`unexpected listing shape from ${url}`);
      rows.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    return rows.slice(0, maxEvents);
  }

  async scrape() {
    const cfg = this._cfg();
    const baseUrl = this.config.base_url || this.config.url;
    const { apiOrigin, portalOrigin, sourceKey } = resolveSource(baseUrl, cfg.portal_url);

    const direction = cfg.upcoming_only === true ? 'upcoming' : 'all';
    const maxEvents = Math.min(Math.max(Number(cfg.max_events) || 2000, 1), 10_000);
    const delayMs = Math.min(Math.max(Number(cfg.request_delay_ms ?? 250), 0), 10_000);
    const eventTypeMap = parseEventTypeMap(cfg.event_type_mappings);
    const excluded = new Set(Array.isArray(cfg.exclude_event_types) ? cfg.exclude_event_types.filter((t) => typeof t === 'string') : []);
    const scraperName = this.config.name || `portal:${sourceKey}`;

    for (const k of ['found', 'processed', 'skipped', 'failed']) {
      if (typeof this.stats[k] !== 'number') this.stats[k] = 0;
    }

    console.log(`🎯 GatewazePortalEventsScraper: ${apiOrigin} (portal ${portalOrigin}, direction=${direction})`);
    const listing = await this._listEvents(apiOrigin, direction, maxEvents);
    console.log(`🔎 ${listing.length} events listed by ${portalOrigin}`);

    const streamingSave = typeof this.globalConfig?.saveEvent === 'function';

    for (const row of listing) {
      const eventId = row?.event_id;
      try {
        if (!isValidEventId(eventId)) {
          this.stats.failed++;
          continue;
        }
        if (row.event_type && excluded.has(row.event_type)) {
          this.stats.skipped++;
          continue;
        }

        // Detail carries the outside link, Luma id, venue and body HTML the
        // listing leaves out. A failed detail fetch skips the event this run
        // rather than saving a thinner copy over a good one.
        let detail;
        try {
          const body = await this._fetchJson(
            `${apiOrigin}/api/portal/events/${encodeURIComponent(eventId)}`,
            MAX_DETAIL_BYTES,
          );
          detail = body?.data && typeof body.data === 'object' ? body.data : body;
        } catch (err) {
          console.warn(`⚠️ detail fetch failed for ${eventId}: ${err.message}`);
          this.stats.failed++;
          continue;
        } finally {
          if (delayMs) await sleep(delayMs);
        }

        const mapped = mapPortalEvent(detail, row, { portalOrigin, sourceKey, scraperName, eventTypeMap });
        if (mapped.skip) {
          console.log(`⏭️ ${eventId}: ${mapped.skip}`);
          this.stats.skipped++;
          continue;
        }

        this.stats.found++;
        if (streamingSave) {
          try {
            await this.globalConfig.saveEvent(mapped.event);
            this.stats.processed++;
          } catch (saveErr) {
            console.warn(`⚠️ Streaming save failed for "${mapped.event.eventTitle}": ${saveErr.message}`);
            this.scrapedEvents.push(mapped.event);
          }
        } else {
          this.scrapedEvents.push(mapped.event);
        }
      } catch (err) {
        console.warn(`⚠️ Failed to process ${eventId}: ${err.message}`);
        this.stats.failed++;
      }
    }

    console.log(
      `✅ GatewazePortalEventsScraper finished: ${this.stats.found} found, ${this.stats.processed} saved, ${this.stats.skipped} skipped, ${this.stats.failed} failed`,
    );
    return this.scrapedEvents;
  }
}
