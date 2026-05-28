# Scrapers

Configure and run web scraping jobs for event discovery and content aggregation. This hidden module provides tools to set up, schedule, and monitor scrapers that pull content from external sources into your Gatewaze instance.

## How It Works

The Scrapers module lets you define web scraping configurations that discover events and aggregate content from external websites. Scrapers can be scheduled to run on a recurring basis, and their results are categorized and filtered before being imported. The module includes its own API routes for triggering and managing scraper runs, database migrations for storing scraper configurations and results, and an admin dashboard for oversight. Title filters and content categories help ensure only relevant content is imported.

## Configuration

This module has no additional configuration settings.

## Features

- `scrapers` -- Core scraping functionality
- `scrapers.manage` -- Create, edit, and monitor scraper configurations
- `scrapers.schedules` -- Schedule scrapers to run automatically on a recurring basis

## Dependencies

- **events** -- Requires the Events module (scraped content is imported as events)

---

## Scraper types

The module ships with two flavours of scraper: classic Puppeteer-driven scrapers and **Fast variants** that route per-event-page fetches through the `scrapling-fetcher` Python service for ~20× per-page speedup.

### Classic (Puppeteer)

Each scraper launches a Chromium instance, navigates to event pages with `puppeteer.goto(...)`, waits for network idle, and extracts data. Reliable but slow: ~10–15 seconds per event.

| Type | Source | Use when |
|---|---|---|
| `LumaICalScraper` | `lu.ma/<calendar-slug>` | Continuously tracking a known Luma calendar |
| `LumaSearchScraper` | Brave Search keywords | Discovering new Luma calendars by topic |
| `LumaCategoryScraper` | `luma.com/<category>` | Bulk-discovering calendars from a category landing page |
| `LumaEventsScraper` | A specific Luma page | One-off ingestion from a curated list |
| `LumaHostEnricher` | Existing event_hosts rows | Filling in LinkedIn / company data on hosts |
| `DevEventsConferenceScraper` | dev.events conference pages | Conference listings |
| `DevEventsMeetupScraper` | dev.events meetup pages | Meetup listings |

### Fast variants (HTTP via scrapling-fetcher)

Three new types take the same configuration as their slow siblings but route per-event-page fetches through the `scrapling-fetcher` HTTP service, skipping the browser. Per-event time drops from ~10 s to ~0.7 s.

| Type | Pairs with | Notes |
|---|---|---|
| `LumaICalScraperFast` | `LumaICalScraper` | iCal feed parsing still uses node-ical; only event-page enrichment changed |
| `LumaSearchScraperFast` | `LumaSearchScraper` | Brave/Google CSE discovery unchanged |
| `LumaCategoryScraperFast` | `LumaCategoryScraper` | Infinite-scroll discovery still uses Puppeteer; per-event fetches use HTTP |

**Fallback is automatic.** If the `scrapling-fetcher` service is unavailable (e.g., not yet deployed in your environment), the Fast variants log a one-line "scrapling-fetcher not configured; falling back" and behave exactly like the slow variant. No data loss, no failed runs.

**Extra config field:** `fast_concurrency` (1–20, default 5) — how many event pages to fetch in parallel. Higher = faster but more proxy bandwidth and risk of upstream rate-limiting.

### When to use which

- **Production scraping of known Luma calendars:** Fast variants
- **One-off backfills (large historical pulls):** Fast variants — savings compound over hundreds of events
- **A/B testing a new scraper config:** Run the slow variant once, the Fast variant once, compare via `/admin/scrapers/comparison`
- **Sites with brittle HTML / anti-bot protection:** Slow variants until we add stealth-mode support (Phase 3)
- **Speaker enrichment:** Speaker extraction now happens **after** the scrape via a follow-up bulk job — speakers populate within ~1–5 minutes whether you use Fast or slow variants

## Comparison page

Visit `/admin/scrapers/comparison` to see paired (slow, fast) scrapers operating on the same calendar with side-by-side stats over a configurable window (1 / 7 / 14 / 30 days):

- Run counts (slow / fast)
- Average duration + speedup ratio
- Average items processed per run
- Success rate

The **Promote Fast** button on each row disables the slow variant and enables the Fast one in a single click. Use it when you have ≥ 3 successful Fast runs that match the slow variant's items count within ~5 %. The button is disabled when the Fast variant has zero runs.

The pair-key normaliser handles common URL typos (`https://lu.ma/foo/`, `luma.com/foo`, `lu.ma/FOO`) so the same calendar registered with two slightly different URLs still pairs cleanly.

## Speaker extraction

Speaker extraction has moved from synchronous-per-event to a bulk follow-up job. Why:

- The scrape job completes ~3× faster — bounded only by fetch + image upload + DB write, no Anthropic latency in the foreground
- Per-brand budgets (see the Cost Governance module) enforce once at the bulk-job boundary instead of N times racing per event
- On `BudgetExceededError`, the unfinished tail of events is re-queued with a delay until the budget window resets — no events are silently skipped

How it appears in your stack:

1. The scraper saves each event as it processes them (you'll see the green ✅ "Saved" log lines as before).
2. At the end of the scrape job, you'll see a single new line: `🎤 Enqueued speaker extraction for N event(s) (processes async; speakers populate within ~1-5 min)`.
3. The worker picks up the bulk job and processes events sequentially, calling Anthropic for each. Logs prefix the lines with `[scraper:speaker-extract]`.
4. Each event's `speakers_extracted_at` column is set when its turn finishes — `NULL` means "not yet extracted."

The admin event listing can show a "speakers pending" badge on rows where `speakers_extracted_at IS NULL`. (The badge UI itself is a follow-up; the column is in place to drive it.)

## Operating recipes

### Spot-check that the Fast variant is actually faster

```bash
docker logs -f gatewaze-worker | grep -iE "scrapling|🐢|🎤|✅ Updated"
```

Healthy fast-path output looks like:
- ✅ Updated lines back-to-back at sub-second intervals (no `⏳ Waiting 2000ms` between)
- No 🐢 lines (those signal fallback to Puppeteer)
- One 🎤 Enqueued speaker extraction line at the end

If you see `⚠️ scrapling fast-path failed for ...` lines, check the `scrapling-fetcher` container's health (`docker ps | grep scrapling-fetcher`).

### A/B against a slow variant

1. Right-click an existing slow scraper → **Duplicate**.
2. Change the duplicate's type to its Fast equivalent.
3. Set a different cron schedule (avoid the slow + fast running at the same minute).
4. Wait one cycle of each (typically 24 hours).
5. Open `/admin/scrapers/comparison` — confirm:
   - Items processed match within ~5 %
   - Fast duration is ≥ 5× lower than slow
   - Fast success rate is ≥ slow success rate
6. Click **Promote Fast** to flip enabled/disabled.

### Rolling back a Fast variant

If a Fast variant misbehaves on a specific calendar:

1. Open the comparison page → click **Revert to slow** on that row.
2. Set `fast_concurrency` lower (e.g., 2 or 1) on the Fast variant and try again at the next cron tick.
3. If it still misbehaves, leave it disabled and add the calendar URL to a per-scraper exclusion list (see source: `LumaICalScraperFast.skip_calendars` config — currently per-instance, not yet UI-exposed).

The slow variant is the source of truth for "we have a working fallback." Don't delete it until the Fast variant has shown a clean ≥ 30 days.
