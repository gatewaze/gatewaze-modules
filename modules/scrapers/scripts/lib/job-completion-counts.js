/**
 * Counts recorded on a completed scrapers_jobs row.
 *
 * Most scrapers return events and the handler counts what its pipeline did
 * with them. Streaming scrapers (LumaICalScraper and friends) save through
 * globalConfig.saveEvent and return [], but the handler's counters still
 * hold their numbers. A scraper that writes its own rows with no handler
 * involvement (the content-sources FeedScraper) opts in with
 * `selfPersisting = true`; only then are its own `stats` the counts. An empty
 * result alone never switches, or every streaming run would record zeros.
 *
 * @param {object|null} scraper
 * @param {unknown[]|null|undefined} events
 * @param {{ processed: number, skipped: number, failed: number }} counts  the handler's own counters
 */
export function jobCompletionCounts(scraper, events, counts) {
  const own = scraper?.selfPersisting === true && scraper?.stats && typeof scraper.stats === 'object' ? scraper.stats : null;
  if (own) {
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      found: n(own.found),
      total: n(own.found),
      processed: n(own.inserted ?? own.processed),
      skipped: n(own.skipped) + n(own.collapsed_url) + n(own.collapsed_title) + n(own.owned_elsewhere),
      failed: n(own.failed_items ?? own.failed),
    };
  }
  return {
    found: events?.length || 0,
    total: events?.length || 0,
    processed: counts.processed,
    skipped: counts.skipped,
    failed: counts.failed,
  };
}
