/**
 * LumaCategoryScraperFast — Fast variant of LumaCategoryScraper.
 *
 * Spec: gatewaze-environments/specs/spec-scrapling-fetcher-service.md §4.3.1.
 *
 * Behavior:
 *   - Inherits the infinite-scroll discovery flow from LumaCategoryScraper
 *     (still uses Puppeteer — that path can't be HTTP).
 *   - Overrides fetchEventPageData to route per-event-page fetches through
 *     the scrapling-fetcher service.
 *   - Falls back to the parent's Puppeteer impl on any service error.
 */

import { LumaCategoryScraper } from './LumaCategoryScraper.js';
import {
  fetchPage,
  ScraplingNotConfiguredError,
} from '../lib/scrapling-fetcher.js';
import { normalizeServiceResponse } from '../lib/luma-fast-normalize.js';


export class LumaCategoryScraperFast extends LumaCategoryScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    this._fastFallbackLogged = false;
    this._fastFailures = 0;
    this._fastSuccesses = 0;
    this._fastConcurrency = Math.max(
      1,
      Math.min(20, config?.config?.fast_concurrency ?? 5),
    );
    // See LumaICalScraperFast for rationale; the inherited 2s pre-fetch
    // throttle is unnecessary on the HTTP fast path.
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
        return super.fetchEventPageData(eventLink);
      }
      this._fastSuccesses++;
      return normalizeServiceResponse(result, { includeCalendarData: true });
    } catch (err) {
      if (err instanceof ScraplingNotConfiguredError) {
        if (!this._fastFallbackLogged) {
          console.log(
            '🐢 scrapling-fetcher not configured; LumaCategoryScraperFast falling back to browser path for this run',
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

  // Normalization moved to lib/luma-fast-normalize.js — see comment in
  // LumaICalScraperFast for rationale.
}
