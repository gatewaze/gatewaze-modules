/**
 * Scraper contribution from the content-sources module.
 *
 * The scrapers module's pluggable registry scans every materialised module for
 * `scrapers/register.js` and merges its default export ({ scraper_type: Class })
 * into the shared registry, so FeedScraper runs from the one Scrapers
 * dashboard without the scrapers module importing it.
 */

import { FeedScraper } from './FeedScraper.js';

export default {
  FeedScraper,
};
