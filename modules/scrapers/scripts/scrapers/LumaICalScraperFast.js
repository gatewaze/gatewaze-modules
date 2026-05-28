/**
 * LumaICalScraperFast — Fast variant of LumaICalScraper.
 *
 * Spec: gatewaze-environments/specs/spec-scrapling-fetcher-service.md §4.3.
 *
 * Behavior:
 *   - Inherits everything from LumaICalScraper.
 *   - Overrides ONE method: fetchEventPageData(eventLink) — routes the
 *     per-event-page HTTP fetch through the scrapling-fetcher service in
 *     `mode: "fast"` instead of Puppeteer's page.goto.
 *   - On any service failure (not configured, transport error, 4xx, 5xx,
 *     missing __NEXT_DATA__), falls back to the parent's Puppeteer
 *     implementation. The slow path is known-good — failure mode is just
 *     "no faster than today."
 *
 * Phase 2 add: in-loop concurrency via p-limit. Phase 1 keeps the existing
 * sequential loop because it preserves the streaming-save ordering
 * invariants that downstream code depends on. The per-page win alone
 * (~20× from skipping the browser) hits the spec target.
 */

import { LumaICalScraper } from './LumaICalScraper.js';
import {
  fetchPage,
  ScraplingNotConfiguredError,
} from '../lib/scrapling-fetcher.js';
import { normalizeServiceResponse } from '../lib/luma-fast-normalize.js';


export class LumaICalScraperFast extends LumaICalScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    this._fastFallbackLogged = false;
    this._fastFailures = 0;
    this._fastSuccesses = 0;
    this._fastConcurrency = Math.max(
      1,
      Math.min(20, config?.config?.fast_concurrency ?? 5),
    );
    // The parent's 2000ms inter-fetch sleep is sized for Puppeteer to
    // dodge per-IP rate limits. The fast path goes through scrapling-
    // fetcher whose service-side per-domain throttle (SCRAPLING_PER_DOMAIN_RPS,
    // default 5/sec) handles the same concern at the right layer.
    // Keeping the parent's 2s wait would add 2s × N events = ~3 min
    // of dead time to a 100-event scrape with no benefit.
    this.pageFetchDelay = 0;
  }

  async fetchEventPageData(eventLink) {
    try {
      const result = await fetchPage(eventLink, {
        mode: 'fast',
        extractNextData: true,
        timeoutMs: 15000,
      });
      if (result.status >= 400 || !result.nextData) {
        // Service worked but the page didn't serve us __NEXT_DATA__ — fall
        // back to the browser path. Same end-of-day as not having a Fast
        // variant for this URL.
        return super.fetchEventPageData(eventLink);
      }
      this._fastSuccesses++;
      return normalizeServiceResponse(result);
    } catch (err) {
      if (err instanceof ScraplingNotConfiguredError) {
        if (!this._fastFallbackLogged) {
          console.log(
            '🐢 scrapling-fetcher not configured; LumaICalScraperFast falling back to browser path for this run',
          );
          this._fastFallbackLogged = true;
        }
      } else {
        this._fastFailures++;
        console.warn(
          `⚠️ scrapling fast-path failed for ${eventLink}: ${err.message} — falling back to Puppeteer`,
        );
      }
      return super.fetchEventPageData(eventLink);
    }
  }

  // Normalization moved to lib/luma-fast-normalize.js so the pure helper
  // can be unit-tested without importing the parent's puppeteer/node-ical
  // top-level deps.
}
