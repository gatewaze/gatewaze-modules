import { LumaSearchScraper } from './LumaSearchScraper.js';

/**
 * LumaCategoryScraper — scrapes Luma category landing pages such as
 * https://luma.com/ai or https://luma.com/startups.
 *
 * Different from a calendar (no iCal feed) and different from
 * LumaSearchScraper (no Brave-search prelude). The page is server-rendered
 * with infinite scroll: a fixed batch of event cards on first paint, more
 * loaded as the user scrolls.
 *
 * Flow:
 *   1. Navigate to baseUrl, wait for the initial batch.
 *   2. Infinite-scroll: scroll to bottom, wait for height to grow, repeat
 *      until either no growth in N consecutive attempts or maxScrolls hit.
 *   3. Extract every `lu.ma/<slug>` event link from the page.
 *   4. For each event, call fetchEventPageData (inherited from
 *      LumaSearchScraper) to grab the event's calendar info.
 *   5. For each unique calendar discovered, idempotently create a child
 *      LumaICalScraper — same logic LumaSearchScraper uses (we extend it
 *      so we get the helper methods and constants for free).
 *
 * Config:
 *   - baseUrl              the category page (required, e.g. https://luma.com/ai)
 *   - maxScrolls           cap on infinite-scroll iterations (default 200)
 *   - scrollPauseMs        wait between scrolls for content to load (default 1500)
 *   - stableScrollChecks   stop after N consecutive scrolls with no new height (default 3)
 *   - maxEventsPerRun      cap on event pages to fetch per run (default 500)
 *   - saveEvents           also save each event as an event record (default false;
 *                          when off, the discovered calendars' iCal scrapers will
 *                          ingest events on their schedule)
 *   - includePastEvents    propagated to auto-created child iCal scrapers (default true)
 */
export class LumaCategoryScraper extends LumaSearchScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    this.config.headless = true;
    this.pageFetchDelay = parseInt(config?.config?.pageFetchDelay ?? '1500');
  }

  validateConfig() {
    const baseUrl = this.config?.baseUrl ?? this.config?.config?.baseUrl;
    if (!baseUrl || !/^https?:\/\/(?:lu\.ma|luma\.com)\//i.test(baseUrl)) {
      throw new Error('LumaCategoryScraper requires baseUrl to be a https://luma.com/<category> or https://lu.ma/<category> URL');
    }
  }

  async scrape() {
    this.validateConfig();

    const cfg = this.config?.config || {};
    const baseUrl = this.config?.baseUrl ?? cfg.baseUrl;
    const maxScrolls = Math.max(1, Math.min(2000, parseInt(cfg.maxScrolls ?? '200')));
    const scrollPauseMs = Math.max(300, parseInt(cfg.scrollPauseMs ?? '1500'));
    const stableScrollChecks = Math.max(1, parseInt(cfg.stableScrollChecks ?? '3'));
    const maxEventsPerRun = Math.max(1, parseInt(cfg.maxEventsPerRun ?? '500'));
    const saveEvents = cfg.saveEvents === true;
    const includePastEvents = cfg.includePastEvents !== false;

    const supabase = this.globalConfig?.supabase;
    if (!supabase) {
      console.warn('⚠️ No Supabase client — discovered calendars will NOT be persisted as iCal scrapers.');
    }

    await this.initialize();

    const discoveredCalendars = new Set();
    const scraperByApiId = new Map(); // apiId → child LumaICalScraper id (calendars created lazily on first event)
    let eventLinks = [];
    let createdCount = 0;
    let existingCount = 0;
    let fetchedCount = 0;
    const scrapedEvents = [];

    try {
      console.log(`🌐 Loading category page: ${baseUrl}`);
      await this.page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));

      // ---- infinite scroll ----
      eventLinks = await this.scrollAndCollectEventLinks({ maxScrolls, scrollPauseMs, stableScrollChecks });
      console.log(`📜 Infinite scroll complete — ${eventLinks.length} unique event links discovered`);

      const limited = eventLinks.slice(0, maxEventsPerRun);
      if (eventLinks.length > maxEventsPerRun) {
        console.log(`⚠️ Capping at maxEventsPerRun=${maxEventsPerRun} (page had ${eventLinks.length})`);
      }

      // ---- per-event drill-down ----
      for (const url of limited) {
        if (this.isShutdownRequested && this.isShutdownRequested()) {
          console.log('📴 Shutdown requested, stopping category scrape');
          break;
        }

        try {
          if (fetchedCount > 0) await new Promise(r => setTimeout(r, this.pageFetchDelay));
          fetchedCount++;
          console.log(`📄 [${fetchedCount}/${limited.length}] Fetching: ${url}`);

          const pageData = await this.fetchEventPageData(url);
          if (!pageData?.calendarData) {
            console.warn(`   ⚠️ No calendar data for ${url}, skipping`);
            this.stats.skipped = (this.stats.skipped ?? 0) + 1;
            continue;
          }

          const cal = pageData.calendarData;
          const result = await this.discoverAndCreateCalendar({
            supabase,
            cal,
            sourceUrl: url,
            includePastEvents,
            inheritedKeywords: null,
            discoveredCalendars,
            scraperByApiId,
          });
          if (result.created) createdCount++;
          else if (result.existed) existingCount++;

          // Optional: also save this event as a record now (saveEvents flag).
          // Otherwise the discovered iCal scrapers will pick it up on their schedule.
          if (saveEvents && pageData.lumaData) {
            const eventRecord = this.buildEventRecord(pageData, url, cal);
            // Hand the child scraper id to the job handler so it can resolve
            // (or lazily create) the calendar this event belongs to.
            if (result.scraperId) eventRecord.calendarScraperId = result.scraperId;
            if (typeof this.globalConfig?.saveEvent === 'function') {
              try {
                await this.globalConfig.saveEvent(eventRecord);
                this.stats.found = (this.stats.found ?? 0) + 1;
              } catch (saveErr) {
                console.warn(`   ⚠️ saveEvent failed: ${saveErr.message}`);
                scrapedEvents.push(eventRecord);
              }
            } else {
              scrapedEvents.push(eventRecord);
            }
          }
        } catch (err) {
          if (this.isBrowserDeadError && this.isBrowserDeadError(err)) {
            console.error(`❌ Browser is dead, aborting: ${err.message}`);
            this.stats.failed = (this.stats.failed ?? 0) + 1;
            throw err;
          }
          console.warn(`   ⚠️ Failed to process ${url}: ${err.message}`);
          this.stats.failed = (this.stats.failed ?? 0) + 1;
        }
      }

      this.stats.total = limited.length;
      this.stats.processed = fetchedCount;
      this.stats.calendarsDiscovered = discoveredCalendars.size;
      this.stats.calendarsCreated = createdCount;
      this.stats.calendarsExisted = existingCount;

      console.log(`\n📊 LumaCategoryScraper complete:`);
      console.log(`   Events scanned: ${fetchedCount}/${limited.length} (page had ${eventLinks.length} total)`);
      console.log(`   Calendars: ${discoveredCalendars.size} unique, ${createdCount} new iCal scrapers, ${existingCount} already existed`);
      if (saveEvents) console.log(`   Event records: ${this.stats.found ?? 0} streamed`);

      this.events = scrapedEvents;
    } catch (err) {
      console.error(`❌ LumaCategoryScraper error: ${err.message}`);
      this.stats.failed = (this.stats.failed ?? 0) + 1;
      this.events = [];
      if (this.isBrowserDeadError && this.isBrowserDeadError(err)) throw err;
    } finally {
      await this.cleanup();
    }

    return this.events;
  }

  /**
   * Scroll to the bottom of the page repeatedly, waiting between scrolls
   * for new content to load. Stop when the page height hasn't grown for
   * `stableScrollChecks` consecutive iterations or `maxScrolls` is hit.
   * Returns deduped, normalised event URLs.
   */
  async scrollAndCollectEventLinks({ maxScrolls, scrollPauseMs, stableScrollChecks }) {
    let lastHeight = 0;
    let stableCount = 0;
    let totalScrolls = 0;

    while (totalScrolls < maxScrolls) {
      totalScrolls++;
      const newHeight = await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        return document.body.scrollHeight;
      });
      await new Promise(r => setTimeout(r, scrollPauseMs));

      if (newHeight === lastHeight) {
        stableCount++;
        if (stableCount >= stableScrollChecks) {
          console.log(`   ↳ Page height stable for ${stableCount} scroll(s) — done (${totalScrolls} total)`);
          break;
        }
      } else {
        stableCount = 0;
        lastHeight = newHeight;
      }
      if (totalScrolls % 10 === 0) {
        console.log(`   ↻ Scrolled ${totalScrolls} times, page height: ${newHeight}`);
      }
    }

    if (totalScrolls >= maxScrolls) {
      console.log(`   ⚠️ Hit maxScrolls=${maxScrolls} — there may be more events the scraper didn't reach`);
    }

    // Extract every lu.ma/<slug> link from the page.
    const links = await this.page.evaluate(() => {
      const set = new Set();
      // Luma event cards typically wrap in <a href="/<slug>"> or
      // <a href="https://lu.ma/<slug>">. Skip user/calendar/category links.
      const reservedPrefixes = ['user/', 'cal-', 'discover', 'category', 'home', 'login', 'signup', 'about', 'help'];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        let url;
        try { url = new URL(href, location.origin); } catch { continue; }
        if (!/^(?:lu\.ma|luma\.com)$/i.test(url.hostname)) continue;
        const path = url.pathname.replace(/^\/+/, '');
        if (!path) continue;
        if (path.includes('/')) continue;            // drop /user/foo etc.
        if (reservedPrefixes.some(p => path.startsWith(p))) continue;
        if (path.length < 3 || path.length > 80) continue;
        // Normalise to lu.ma + drop query/hash.
        set.add(`https://lu.ma/${path}`);
      }
      return Array.from(set);
    });

    return links;
  }

  /**
   * Idempotent: given a calendar discovered from an event page, ensure a
   * LumaICalScraper exists for it. Mirrors the logic in
   * LumaSearchScraper.scrape() but factored to a method so this scraper
   * can call it inline. Returns { created, existed, scraperId }.
   *
   * Calendar rows are no longer eagerly created here. The job handler
   * lazily creates one the first time an event for the returned scraper
   * id lands, so scrapers that never produce events don't leave empty
   * calendar shells behind.
   */
  async discoverAndCreateCalendar({
    supabase, cal, sourceUrl, includePastEvents, inheritedKeywords,
    discoveredCalendars, scraperByApiId,
  }) {
    if (!cal?.apiId) return { created: false, existed: false, scraperId: null };
    if (discoveredCalendars.has(cal.apiId)) {
      return { created: false, existed: true, scraperId: scraperByApiId.get(cal.apiId) ?? null };
    }
    discoveredCalendars.add(cal.apiId);
    console.log(`📅 Calendar discovered: "${cal.name}" (${cal.slug || cal.apiId})`);

    if (!supabase) return { created: false, existed: false, scraperId: null };
    if (!cal.slug) return { created: false, existed: false, scraperId: null };

    const calendarUrl = `https://lu.ma/${cal.slug}`;
    const name = `Luma: ${cal.name}`;

    const { data: existing } = await supabase
      .from('scrapers').select('id, config')
      .or(`base_url.eq.${calendarUrl},config->>ical_id.eq.${cal.apiId}`)
      .maybeSingle();

    if (existing) {
      scraperByApiId.set(cal.apiId, existing.id);
      console.log(`   ↳ iCal scraper already exists for "${name}"`);
      return { created: false, existed: true, scraperId: existing.id };
    }

    // Create a new iCal scraper for this calendar.
    const childConfig = {
      account: cal.name,
      ical_id: cal.apiId,
      past: includePastEvents !== false,
      _provenance: {
        auto_discovered: true,
        discovered_by: this.config?.name,
        discovered_from: sourceUrl,
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
      return { created: false, existed: false, scraperId: null };
    }

    console.log(`   ✅ Created iCal scraper: "${name}" (daily at ${scheduleTime} UTC)`);
    scraperByApiId.set(cal.apiId, newScraper?.id ?? null);
    return { created: true, existed: false, scraperId: newScraper?.id ?? null };
  }

  /**
   * Build an event record (LumaSearchScraper / LumaICalScraper shape) from
   * a fetched event page so the streaming saveEvent pipeline can consume it.
   */
  buildEventRecord(pageData, url, cal) {
    const ld = pageData.lumaData ?? {};
    return {
      eventTitle: ld.name || 'Untitled',
      eventDescription: ld.description || pageData.pageContent?.slice(0, 2000) || null,
      eventStart: ld.startAt || null,
      eventEnd: ld.endAt || null,
      eventTimezone: ld.timezone || 'UTC',
      eventCity: ld.city || null,
      eventCountryCode: ld.countryCode || null,
      eventRegion: ld.region || null,
      eventLocation: ld.latitude && ld.longitude ? `${ld.latitude},${ld.longitude}` : null,
      venueAddress: ld.venueAddress || ld.fullAddress || null,
      eventLink: url,
      eventLogo: ld.coverUrl || pageData.coverImageUrl || null,
      eventType: pageData.isVirtual ? 'virtual' : (ld.locationType || 'in-person'),
      eventTopics: [],
      sourceType: 'luma_category',
      sourceDetails: {
        category_url: this.config?.baseUrl ?? this.config?.config?.baseUrl,
        luma_event_id: ld.lumaEventId,
        luma_calendar_id: cal?.apiId,
        luma_calendar_slug: cal?.slug,
      },
      eventSourceName: cal?.name || null,
      lumaEventId: ld.lumaEventId,
    };
  }
}
