/**
 * LumaSearchScraper
 *
 * Discovers Luma events by keyword using Google Custom Search Engine (CSE) API,
 * then extracts structured event data from each result page using Puppeteer.
 */

import { BaseScraper } from './BaseScraper.js';

// Reserved Luma paths that are NOT event pages
const RESERVED_PATHS = new Set([
  'discover', 'explore', 'home', 'about', 'pricing',
  'signin', 'signup', 'settings', 'calendar', 'create',
  'help', 'terms', 'privacy', 'blog', 'changelog',
  'integrations', 'api', 'docs', 'careers', 'press'
]);

export class LumaSearchScraper extends BaseScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    this.pageFetchDelay = 2000;
    this.cseQueriesUsed = 0;
  }

  // Validate config before starting
  validateConfig() {
    const cfg = this.config?.config || {};
    if (!cfg.keywords || !Array.isArray(cfg.keywords) || cfg.keywords.length === 0) {
      throw new Error('Config error: keywords must be a non-empty array');
    }
    if (cfg.keywords.length > 10) {
      throw new Error('Config error: maximum 10 keywords allowed');
    }
    for (const kw of cfg.keywords) {
      if (typeof kw !== 'string' || kw.length === 0 || kw.length > 200) {
        throw new Error(`Config error: each keyword must be 1-200 characters, got: "${kw}"`);
      }
    }
    const validDateRestricts = ['m1', 'm3', 'm6', 'y1'];
    if (cfg.dateRestrict && !validDateRestricts.includes(cfg.dateRestrict)) {
      throw new Error(`Config error: dateRestrict must be one of ${validDateRestricts.join(', ')}`);
    }
    if (cfg.maxResultsPerKeyword !== undefined) {
      const max = parseInt(cfg.maxResultsPerKeyword);
      if (isNaN(max) || max < 10 || max > 100) {
        throw new Error('Config error: maxResultsPerKeyword must be 10-100');
      }
    }
  }

  // Check if a URL is a valid Luma event page
  isValidEventUrl(urlStr) {
    try {
      const url = new URL(urlStr);
      // Normalise luma.com to lu.ma
      const hostname = url.hostname.replace('www.', '');
      if (hostname !== 'lu.ma' && hostname !== 'luma.com') return false;
      // Must have no query params
      if (url.search) return false;
      // Must be a single path segment
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length !== 1) return false;
      // Must not be a reserved path
      if (RESERVED_PATHS.has(segments[0].toLowerCase())) return false;
      return true;
    } catch {
      return false;
    }
  }

  // Search for Luma events by keyword.
  // Supports two backends:
  //   1. Brave Search API (BRAVE_SEARCH_API_KEY) — 2,000 free queries/month
  //   2. Google CSE JSON API (GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID) — 100 free queries/day
  // Brave is tried first if configured; Google CSE is the fallback.
  async searchGoogle(keyword, maxResults = 30) {
    if (process.env.BRAVE_SEARCH_API_KEY) {
      return this._searchBrave(keyword, maxResults);
    }

    const apiKey = process.env.GOOGLE_CSE_API_KEY;
    const cseId = process.env.GOOGLE_CSE_ID;
    if (apiKey && cseId) {
      return this._searchGoogleCse(keyword, maxResults, apiKey, cseId);
    }

    throw new Error(
      'No search API configured. Set either BRAVE_SEARCH_API_KEY (recommended, free at https://brave.com/search/api/) ' +
      'or GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID.'
    );
  }

  // Brave Search API — free tier: 2,000 queries/month, no credit card needed
  // Sign up at https://brave.com/search/api/ and get an API key
  async _searchBrave(keyword, maxResults = 30) {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    const results = [];
    const pageSize = 20; // Brave returns up to 20 results per request
    const MAX_PAGE = 9;  // Brave's offset is a PAGE NUMBER (0–9), not a row offset
    const maxPages = Math.min(MAX_PAGE + 1, Math.ceil(maxResults / pageSize));

    for (let page = 0; page < maxPages; page++) {
      const budget = parseInt(process.env.SEARCH_DAILY_BUDGET || process.env.GOOGLE_CSE_DAILY_BUDGET || '100');
      if (this.cseQueriesUsed >= budget) {
        console.log(`⚠️ Daily search budget (${budget}) reached. Stopping search.`);
        break;
      }

      // Bias toward fresh results — configurable via scraper config.freshness or
      // BRAVE_FRESHNESS env var. Valid: pd (past day), pw (past week), pm (past month),
      // py (past year), or unset (all time). Default: unset, rely on post-fetch past-event filter.
      const cfg = this.config?.config || {};
      const freshness = cfg.freshness || process.env.BRAVE_FRESHNESS;

      const remaining = maxResults - results.length;
      const params = new URLSearchParams({
        q: `${keyword} site:lu.ma`,
        count: String(Math.min(pageSize, remaining)),
        offset: String(page),
        search_lang: 'en',
        text_format: 'raw',
      });
      if (freshness) params.set('freshness', freshness);

      try {
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': apiKey,
          },
        });
        this.cseQueriesUsed++;

        if (response.status === 429) {
          console.log(`⚠️ Brave Search quota exceeded (429). Stopping search.`);
          break;
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Brave Search API key invalid (${response.status}). Check BRAVE_SEARCH_API_KEY.`);
        }
        // 422 on a non-zero page typically means Brave has no further pages for
        // this query — treat as end-of-results, not an error worth warning about.
        if (response.status === 422 && page > 0) break;
        if (!response.ok) {
          console.warn(`⚠️ Brave Search error ${response.status} for keyword "${keyword}" (page ${page}). Skipping.`);
          break;
        }

        const data = await response.json();
        const webResults = data?.web?.results || [];
        if (webResults.length === 0) break;

        // Transform Brave results to match the { link, title, snippet } format
        for (const item of webResults) {
          results.push({
            link: item.url,
            title: item.title || '',
            snippet: item.description || '',
          });
        }

        // If fewer results than requested, no more pages
        if (webResults.length < pageSize) break;

        // Brave rate limit: be polite
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        if (err.message.includes('invalid') || err.message.includes('401') || err.message.includes('403')) throw err;
        console.warn(`⚠️ Brave search failed for "${keyword}" (page=${page}): ${err.message}`);
        break;
      }
    }

    console.log(`🔍 Brave Search: found ${results.length} results for "${keyword}"`);
    return results;
  }

  // Google CSE JSON API search
  async _searchGoogleCse(keyword, maxResults, apiKey, cseId) {
    const cfg = this.config?.config || {};
    const dateRestrict = cfg.dateRestrict || 'm3';
    const results = [];

    for (let start = 1; start <= Math.min(maxResults, 91); start += 10) {
      const budget = parseInt(process.env.GOOGLE_CSE_DAILY_BUDGET || '100');
      if (this.cseQueriesUsed >= budget) {
        console.log(`⚠️ Daily CSE query budget (${budget}) reached. Stopping search.`);
        break;
      }

      const params = new URLSearchParams({
        key: apiKey,
        cx: cseId,
        q: keyword,
        siteSearch: 'lu.ma',
        num: '10',
        start: String(start),
        dateRestrict,
      });

      try {
        const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
        this.cseQueriesUsed++;

        if (response.status === 429) {
          console.log(`⚠️ Google CSE quota exceeded (429). Stopping search.`);
          break;
        }
        if (response.status === 403) {
          const body = await response.json().catch(() => ({}));
          throw new Error(`Google CSE API 403: ${body?.error?.message || ''}. Check that Custom Search API is enabled in the same GCP project as the API key.`);
        }
        if (response.status === 400) {
          const errorBody = await response.json().catch(() => ({}));
          throw new Error(`Google CSE bad request: ${errorBody?.error?.message || response.statusText}`);
        }
        if (!response.ok) {
          console.warn(`⚠️ Google CSE error ${response.status} for keyword "${keyword}". Skipping.`);
          break;
        }

        const data = await response.json();
        if (!data.items || data.items.length === 0) break;

        results.push(...data.items);
        if (data.items.length < 10) break;
      } catch (err) {
        if (err.message.includes('invalid') || err.message.includes('bad request') || err.message.includes('403')) throw err;
        console.warn(`⚠️ CSE request failed for "${keyword}" (start=${start}): ${err.message}`);
        break;
      }
    }

    return results;
  }

  // Filter Google results to valid Luma event URLs
  filterEventUrls(items) {
    const urls = [];
    for (const item of items) {
      const link = item.link;
      if (link && this.isValidEventUrl(link)) {
        // Normalise to lu.ma
        const url = new URL(link);
        const hostname = url.hostname.replace('www.', '');
        const normalised = hostname === 'luma.com'
          ? `https://lu.ma${url.pathname}`
          : link.split('?')[0]; // strip any query params just in case
        urls.push(normalised);
      }
    }
    return [...new Set(urls)]; // dedupe within results
  }

  // Detect event type from title
  detectEventType(title) {
    if (!title) return 'meetup';
    const lower = title.toLowerCase();
    if (/webinar|online|virtual/.test(lower)) return 'webinar';
    if (/workshop|hands-on|masterclass/.test(lower)) return 'workshop';
    if (/conference|summit|expo|days/.test(lower)) return 'conference';
    return 'meetup';
  }

  // Main scrape method
  async scrape() {
    this.validateConfig();

    const cfg = this.config?.config || {};
    const keywords = cfg.keywords;
    const maxResultsPerKeyword = parseInt(cfg.maxResultsPerKeyword || '30');
    // saveEvents: also persist each event page found as an event record (hosts
    // and speakers are extracted by the job handler). Without this, the scraper
    // only discovers calendars and auto-creates child iCal scrapers.
    const saveEvents = cfg.saveEvents === true;
    // includePastEvents: when saveEvents is on, also keep events whose end time
    // has already passed. `past: true` is honoured as an alias for legacy configs.
    const includePastEvents = cfg.includePastEvents === true || cfg.past === true;
    // Under the unified "keywords" model, the same list drives Brave searches,
    // the pre-fetch title filter, and the inherited page-content filter on child
    // iCal scrapers. Legacy `titleFilters` is still honoured for existing configs.
    const filterKeywords = Array.isArray(cfg.titleFilters) && cfg.titleFilters.length > 0
      ? cfg.titleFilters
      : (Array.isArray(keywords) ? keywords : []);

    console.log(`🔍 LumaSearchScraper: ${keywords.length} keywords, max ${maxResultsPerKeyword} results each`);

    // Initialize browser for page extraction
    await this.initialize();

    try {
      // Load processed URLs for dedup
      await this.loadProcessedUrls();

      // Phase 1: Discover URLs via Google CSE
      const allItems = [];
      for (const keyword of keywords) {
        console.log(`🔎 Searching: "${keyword}"`);
        try {
          const items = await this.searchGoogle(keyword, maxResultsPerKeyword);
          console.log(`   → ${items.length} results`);
          allItems.push(...items);
        } catch (err) {
          console.error(`❌ Search failed for "${keyword}": ${err.message}`);
          if (err.message.includes('invalid') || err.message.includes('not set')) throw err;
          this.stats.failed++;
        }
      }

      console.log(`📊 CSE queries used: ${this.cseQueriesUsed}`);

      // Phase 2: Filter to valid event URLs
      const eventUrls = this.filterEventUrls(allItems);
      console.log(`🔗 ${eventUrls.length} valid event URLs after filtering`);

      // Phase 3: Deduplicate
      const newUrls = eventUrls.filter(url => {
        if (this.processedUrls.has(url)) {
          this.stats.skipped++;
          return false;
        }
        return true;
      });
      console.log(`🆕 ${newUrls.length} new URLs after dedup (${this.stats.skipped} skipped)`);

      this.stats.total = newUrls.length;

      // No pre-filter: fetch every URL Brave returns, since keyword matching against
      // page content happens at extraction time (title OR page content). A URL whose
      // title doesn't mention the keyword might still be a match via its description.
      let urlsToFetch = newUrls;

      // Pre-fetch dedup: skip URLs we've already saved as events. The job
      // handler's isDuplicate() would catch these downstream, but only after
      // we've spent 5–7s fetching each page via Puppeteer. Querying events.event_link
      // up-front trims that wasted work — 100 previously-seen URLs are 8+ minutes
      // of Puppeteer time saved. We still discover NEW calendars on pages we
      // haven't seen, so this purely trims redundant re-fetches.
      if (this.globalConfig?.supabase && urlsToFetch.length > 0) {
        try {
          const { data: existingEventRows } = await this.globalConfig.supabase
            .from('events')
            .select('event_link')
            .in('event_link', urlsToFetch);
          const existingLinks = new Set((existingEventRows || []).map((r) => r.event_link));
          if (existingLinks.size > 0) {
            const filtered = urlsToFetch.filter((u) => !existingLinks.has(u));
            const skipped = urlsToFetch.length - filtered.length;
            console.log(`⏭️  Skipping ${skipped} URL(s) — already saved as events in Gatewaze`);
            this.stats.skipped = (this.stats.skipped || 0) + skipped;
            urlsToFetch = filtered;
          }
        } catch (err) {
          console.warn(`⚠️ Pre-fetch dedup query failed (non-fatal, will still dedup at save time): ${err.message}`);
        }
      }

      // Phase 5: Discover CALENDARS (not events) and auto-create iCal scrapers
      // as soon as each one is found (streaming, not batch-at-end). This means
      // a crash/kill mid-run loses nothing already discovered, the SSE modal
      // shows live progress, and deduplication works correctly even if two
      // search scrapers happen to run concurrently.
      const discoveredCalendars = new Set(); // apiId — tracked to dedupe within this run
      const scraperByApiId = new Map(); // apiId → child LumaICalScraper id (so events know which scraper's calendar to lazily resolve to)
      const supabase = this.globalConfig?.supabase;
      let fetchedCount = 0;
      let notMatchedCount = 0;
      let createdCount = 0;
      let existingCount = 0;
      let eventsBuilt = 0;
      let eventsPastSkipped = 0;
      const scrapedEvents = []; // event records returned for the job handler to persist
      const inheritedKeywords = filterKeywords.length > 0 ? filterKeywords : null;

      if (saveEvents) {
        console.log(`📝 Event-record saving: ENABLED${includePastEvents ? ' (including past events)' : ' (future events only)'}`);
      }

      if (!supabase) {
        console.warn(`⚠️ No Supabase client available — calendars discovered in this run will NOT be persisted as iCal scrapers.`);
      }

      for (const url of urlsToFetch) {
        try {
          if (fetchedCount > 0) {
            await new Promise(r => setTimeout(r, this.pageFetchDelay));
          }
          fetchedCount++;

          console.log(`📄 Fetching: ${url}`);
          const pageData = await this.fetchEventPageData(url);

          if (!pageData || !pageData.calendarData) {
            console.warn(`⚠️ No calendar data for ${url}, skipping`);
            this.stats.failed++;
            continue;
          }

          // Keyword post-filter removed: visibility is now decided by the
          // platform-wide content-keywords module after ingest. This scraper
          // still uses cfg.keywords to *drive* the Brave search (lines ~297),
          // but matched events are no longer dropped here on title/content
          // mismatch — they're stored and shown/hidden via rules later.

          const cal = pageData.calendarData;

          // Resolve the calendar UUID for this page. First encounter within the
          // run does the real work (create iCal scraper + calendar row); later
          // encounters reuse the cached UUID. If the calendar already exists in
          // Gatewaze (from a prior run), we pick up its UUID without creating
          // anything new.
          // childScraperId = the LumaICalScraper that owns this calendar.
          // We pass this onto the saved event so the job handler can find
          // (or lazily create) the calendar at link time. Calendars are no
          // longer eagerly materialised here — that left empty shells for
          // any scraper that never produced events.
          let childScraperId = scraperByApiId.get(cal.apiId) || null;

          if (!discoveredCalendars.has(cal.apiId)) {
            discoveredCalendars.add(cal.apiId);
            console.log(`📅 New calendar discovered: "${cal.name}" (${cal.slug || cal.apiId}) via "${pageData.lumaData?.name || url}"`);

            if (supabase) {
              if (cal.slug) {
                const calendarUrl = `https://lu.ma/${cal.slug}`;
                const name = `Luma: ${cal.name}`;

                // Idempotent: existing scraper check. If one exists, re-sync
                // its inherited config (keywords / past) so changes to the
                // parent propagate to children without needing a manual edit.
                const { data: existing } = await supabase
                  .from('scrapers')
                  .select('id, config')
                  .or(`base_url.eq.${calendarUrl},config->>ical_id.eq.${cal.apiId}`)
                  .maybeSingle();

                if (existing) {
                  existingCount++;
                  childScraperId = existing.id;
                  const existingConfig = existing.config || {};
                  const existingKeywords = Array.isArray(existingConfig.keywords) ? existingConfig.keywords : null;
                  const desiredKeywords = inheritedKeywords || null;
                  const keywordsChanged = JSON.stringify(existingKeywords) !== JSON.stringify(desiredKeywords);
                  const pastDesired = includePastEvents !== false;
                  const pastChanged = existingConfig.past !== pastDesired;

                  if (keywordsChanged || pastChanged) {
                    const mergedConfig = { ...existingConfig };
                    if (desiredKeywords) mergedConfig.keywords = desiredKeywords;
                    else delete mergedConfig.keywords;
                    mergedConfig.past = pastDesired;
                    const { error: syncErr } = await supabase
                      .from('scrapers').update({ config: mergedConfig }).eq('id', existing.id);
                    if (syncErr) console.warn(`   ⚠️ Failed to re-sync config for "${name}": ${syncErr.message}`);
                    else {
                      const changes = [];
                      if (keywordsChanged) changes.push(`keywords → [${desiredKeywords ? desiredKeywords.join(', ') : 'none'}]`);
                      if (pastChanged) changes.push(`past → ${pastDesired}`);
                      console.log(`   🔄 Re-synced "${name}": ${changes.join('; ')}`);
                    }
                  } else {
                    console.log(`   ↳ iCal scraper already exists: "${name}" (config in sync)`);
                  }
                } else {
                  // New iCal scraper. The matching calendar is created
                  // lazily by scraper-job-handler.js when the first event
                  // for this scraper lands.
                  const childConfig = {
                    account: cal.name,
                    ical_id: cal.apiId,
                    past: includePastEvents !== false,
                    _provenance: {
                      auto_discovered: true,
                      discovered_by: this.config?.name,
                      discovered_from: url,
                    },
                  };
                  if (inheritedKeywords) childConfig.keywords = inheritedKeywords;
                  const scheduleHour = Math.floor(Math.random() * 9);
                  const scheduleMinute = Math.floor(Math.random() * 60);
                  const scheduleTime = `${String(scheduleHour).padStart(2, '0')}:${String(scheduleMinute).padStart(2, '0')}`;

                  const { data: newScraper, error: insertErr } = await supabase
                    .from('scrapers')
                    .insert({
                      name, description: null, scraper_type: 'LumaICalScraper',
                      event_type: 'mixed', base_url: calendarUrl, enabled: true,
                      schedule_enabled: true, schedule_frequency: 'daily',
                      schedule_time: scheduleTime, timezone: 'UTC', config: childConfig,
                    })
                    .select('id').single();

                  if (insertErr) {
                    console.error(`   ❌ Failed to create scraper for "${name}": ${insertErr.message}`);
                    this.stats.failed++;
                  } else {
                    createdCount++;
                    childScraperId = newScraper?.id ?? null;
                    console.log(`   ✅ Created iCal scraper: "${name}" (enabled, daily at ${scheduleTime} UTC)`);
                  }
                }
              } else {
                console.warn(`⚠️ Calendar "${cal.name}" has no slug — cannot derive iCal URL, skipping scraper creation`);
              }
            }

            if (childScraperId) scraperByApiId.set(cal.apiId, childScraperId);
          } else {
            console.log(`📅 Calendar already seen this run: "${cal.name}" (matched again via ${url})`);
          }

          // Event build — done after scraper resolution so the saved row
          // can carry `calendarScraperId`. The job handler resolves (or
          // lazily creates) the calendar from that scraper id at link time.
          if (saveEvents && pageData.lumaData && pageData.lumaData.startAt) {
            const endIso = pageData.lumaData.endAt || pageData.lumaData.startAt;
            const isPast = new Date(endIso) < new Date();
            if (isPast && !includePastEvents) {
              eventsPastSkipped++;
              console.log(`⏭️ Past event skipped (includePastEvents off): "${pageData.lumaData.name || url}"`);
            } else {
              const built = this.buildEventFromPageData(pageData, url);
              if (built) {
                if (childScraperId) built.calendarScraperId = childScraperId;
                scrapedEvents.push(built);
                eventsBuilt++;
                console.log(`📝 Event captured${isPast ? ' (past)' : ''}${childScraperId ? ' (calendar scraper linked)' : ''}: "${built.eventTitle}"`);
              }
            }
          } else if (saveEvents && !pageData.lumaData?.startAt) {
            console.log(`⏭️ Skipped (no start date — likely calendar page, not an event): ${url}`);
          }
        } catch (err) {
          console.error(`❌ Failed to extract ${url}: ${err.message}`);
          this.stats.failed++;
        }
      }

      if (filterKeywords.length > 0) {
        console.log(`🔍 ${notMatchedCount} events skipped due to no keyword match`);
      }

      this.stats.processed = createdCount;
      this.stats.skipped = existingCount;
      this.stats.total = discoveredCalendars.size;
      this.stats.found = scrapedEvents.length;

      console.log(`\n📊 LumaSearchScraper complete: ${discoveredCalendars.size} unique calendars discovered, ${createdCount} new iCal scrapers created, ${existingCount} already existed`);
      if (saveEvents) {
        console.log(`   Event records built: ${eventsBuilt} (past skipped: ${eventsPastSkipped})`);
      }
      console.log(`   Search queries: ${this.cseQueriesUsed}, Pages fetched: ${fetchedCount}, Failed: ${this.stats.failed}`);

      // Return the captured events so the job handler can persist them and
      // run host/speaker extraction. When saveEvents is off this is empty, and
      // the scraper's only persistent output is the auto-created iCal scrapers.
      return scrapedEvents;

    } finally {
      await this.cleanup();
    }
  }

  // Build an event record (matching the shape produced by LumaICalScraper.parseICalEvent)
  // from a page fetched via Brave Search. The job handler processes this through
  // EventProcessor + host/speaker extraction exactly like iCal-sourced events.
  buildEventFromPageData(pageData, url) {
    const l = pageData.lumaData || {};
    if (!l.lumaEventId && !l.startAt) return null;

    const lat = l.latitude;
    const lng = l.longitude;
    const coordinates = (lat !== undefined && lat !== null && lng !== undefined && lng !== null)
      ? { lat, lng }
      : null;
    const eventLocation = coordinates ? `${coordinates.lat},${coordinates.lng}` : null;

    // Virtual detection mirrors LumaICalScraper: locationType=online, or .icon-row
    // text, or explicit flag. When virtual and no city, default to 'online'.
    const isVirtual = pageData.isVirtual === true || l.locationType === 'online';
    let eventCity = l.city || null;
    let eventRegion = l.region || null;
    if (isVirtual && !eventCity && !eventRegion) {
      eventCity = 'online';
      eventRegion = 'on';
    }

    const eventName = l.name || '';

    return {
      name: eventName,
      eventTitle: eventName,
      url,
      event_link: url,
      eventId: null, // assigned by the job handler via generateEventId
      lumaEventId: l.lumaEventId || null,
      sourceEventId: l.lumaEventId || null,

      eventStart: l.startAt || null,
      eventEnd: l.endAt || null,

      eventLocation,
      eventCity,
      eventCountry: l.country || null,
      eventCountryCode: l.countryCode || null,
      eventRegion,
      venueAddress: l.fullAddress || l.venueAddress || null,
      coordinates,

      eventTimezone: l.timezone || 'UTC',
      eventType: this.detectEventType(eventName),

      scraperName: this.config?.name,
      scrapedAt: new Date().toISOString(),

      description: l.description || '',
      organizer: pageData.calendarData?.name || null,

      coverImageUrl: pageData.coverImageUrl || l.coverUrl || null,
      pageContent: pageData.pageContent || '',
      lumaPageData: pageData.lumaPageData || null,

      account: this.config?.config?.account || null,
    };
  }

  // Reuse fetchEventPageData from LumaICalScraper
  // This is the same method — navigates to a Luma event page,
  // extracts cover image, __NEXT_DATA__, and page content
  async fetchEventPageData(eventLink) {
    let retries = 2;
    while (retries > 0) {
      try {
        await this.page.goto(eventLink, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
        await new Promise(r => setTimeout(r, 3000));

        const pageData = await this.page.evaluate(() => {
          // Cover image
          let coverImageUrl = null;
          const coverImg = document.querySelector('.cover-image img');
          if (coverImg) {
            coverImageUrl = coverImg.src || null;
            if (!coverImageUrl && coverImg.srcset) {
              const srcsetParts = coverImg.srcset.split(',').map(s => s.trim().split(' '));
              if (srcsetParts.length > 0) coverImageUrl = srcsetParts[srcsetParts.length - 1][0];
            }
          }

          // Virtual detection
          let isVirtual = false;
          document.querySelectorAll('.icon-row').forEach(row => {
            const titleEl = row.querySelector('.title');
            if (titleEl && titleEl.textContent.toLowerCase().includes('virtual')) {
              isVirtual = true;
            }
          });

          // Page content
          const pageContent = (document.body?.innerText || '').substring(0, 5000);

          // __NEXT_DATA__
          let lumaData = null;
          let lumaPageData = null;
          let calendarData = null;
          const nextDataScript = document.querySelector('script#__NEXT_DATA__');
          if (nextDataScript) {
            try {
              const fullData = JSON.parse(nextDataScript.textContent);
              lumaPageData = fullData;
              const pageDataRoot = fullData?.props?.pageProps?.initialData?.data
                || fullData?.props?.pageProps?.data;
              const eventData = pageDataRoot?.event;
              if (eventData) {
                lumaData = {
                  lumaEventId: eventData.api_id,
                  name: eventData.name,
                  startAt: eventData.start_at,
                  endAt: eventData.end_at,
                  timezone: eventData.timezone,
                  coverUrl: eventData.cover_url,
                  latitude: eventData.coordinate?.latitude || eventData.geo_latitude,
                  longitude: eventData.coordinate?.longitude || eventData.geo_longitude,
                  city: eventData.geo_address_info?.city,
                  country: eventData.geo_address_info?.country,
                  countryCode: eventData.geo_address_info?.country_code,
                  region: eventData.geo_address_info?.region,
                  venueAddress: eventData.geo_address_info?.address,
                  fullAddress: eventData.geo_address_info?.full_address,
                  locationType: eventData.location_type,
                  description: eventData.description_mirror || eventData.description || '',
                };
              }
              // Extract calendar (community/organizer) info — present on most event pages
              const calData = pageDataRoot?.calendar;
              if (calData && calData.api_id) {
                calendarData = {
                  apiId: calData.api_id,
                  name: calData.name || '',
                  slug: calData.slug || '',
                  url: calData.slug ? `https://lu.ma/${calData.slug}` : null,
                };
              }
            } catch (e) {
              // JSON parse failed
            }
          }

          return { coverImageUrl, pageContent, isVirtual, lumaData, lumaPageData, calendarData };
        });

        // Strip user-specific data from lumaPageData
        if (pageData.lumaPageData) {
          try {
            delete pageData.lumaPageData.props?.pageProps?.initialData?.data?.guests;
            delete pageData.lumaPageData.props?.pageProps?.initialData?.data?.user;
          } catch {}
        }

        return pageData;
      } catch (err) {
        retries--;
        if (retries > 0) {
          console.warn(`⚠️ Retry for ${eventLink}: ${err.message}`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          throw err;
        }
      }
    }
  }
}
