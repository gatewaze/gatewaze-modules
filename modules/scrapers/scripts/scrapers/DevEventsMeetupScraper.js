import { BaseScraper } from './BaseScraper.js';
import { fetchHtml, sleep, extractListingRows, extractListingTotal, hasMoreListingPages, listingPageUrl, extractDetail, extractNextData, lumaDataFromNextData, meetupDataFromNextData, isLumaUrl, isMeetupUrl, isDevEventsUrl, DEV_EVENTS_HOSTS, LUMA_HOSTS, MEETUP_HOSTS } from './devEventsHttp.js';
import { resolveResidentialEgress } from '../lib/scrapling-fetcher.js';

/**
 * Scraper for dev.events meetups page
 */
export class DevEventsMeetupScraper extends BaseScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    // Set headless mode (false for debugging, true for production)
    this.config.headless = true;
    // Track current region being scraped
    this.currentRegion = null;
  }

  /**
   * dev.events is scraped over plain HTTP — no browser (see devEventsHttp.js).
   */
  async initialize() {
    console.log(`🚀 Initializing ${this.config.name} scraper (HTTP mode, no browser)...`);
    this.browser = null;
    this.page = null;
    // Per-scraper `use_residential_egress` (config JSON) → SCRAPERS_RESIDENTIAL_EGRESS env → off.
    this._egress = { use: resolveResidentialEgress(this.config), jobId: this.config.jobId ?? null };
    console.log(`🛰️ Residential egress: ${this._egress.use ? 'on (via scrapling-fetcher, proxy forced)' : 'off (direct fetch from the worker)'}`);
  }


  /**
   * Main scraping method
   */
  async scrape() {
    console.log(`🎯 Starting ${this.config.name} scraping...`);

    await this.initialize();
    this.loadProcessedUrls();

    try {
      // If regions are configured, scrape each region
      if (this.config.config.regions && this.config.config.regions.length > 0) {
        for (const region of this.config.config.regions) {
          await this.scrapeRegion(region);
          // Small delay between regions
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } else {
        // Scrape main meetups page
        await this.scrapePage(this.config.config.baseUrl);
      }

      console.log(`✅ Completed meetups scraping`);

    } catch (error) {
      console.error(`❌ Meetups scraping error: ${error.message}`);
      throw error;
    } finally {
      await this.cleanup();
    }

    this.printStats();
    return this.scrapedEvents;
  }

  /**
   * Scrape a specific region
   */
  async scrapeRegion(region) {
    console.log(`🌍 Scraping region: ${region}`);
    this.currentRegion = region.toLowerCase(); // Store region in lowercase for database
    const regionUrl = `https://dev.events/meetups/${region}`;
    console.log(`🔗 Region URL: ${regionUrl}`);

    try {
      await this.scrapePage(regionUrl);
    } catch (error) {
      console.error(`❌ Error scraping region ${region}: ${error.message}`);
    }
  }

  /**
   * Walk the listing pages over HTTP (`?page=N`) and process every row.
   * dev.events is server-rendered, so no browser is involved — see
   * devEventsHttp.js for why the browser path was dropped.
   */
  async scrapePage(baseUrl) {
    console.log(`📄 Starting pagination scraping from: ${baseUrl}`);
    const configuredMax = parseInt(this.config?.config?.maxPages, 10);
    const maxPages = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 50;
    let totalEvents = null;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;
    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages && consecutiveErrors < maxConsecutiveErrors && currentPage <= maxPages) {
      const pageUrl = listingPageUrl(baseUrl, currentPage);
      console.log(`📄 Processing page ${currentPage}: ${pageUrl}`);
      try {
        const { status, html } = await fetchHtml(pageUrl, { allow: DEV_EVENTS_HOSTS, timeoutMs: 45000, egress: this._egress });
        if (status >= 400) throw new Error(`HTTP ${status} for ${pageUrl}`);
        if (totalEvents === null) {
          totalEvents = extractListingTotal(html) ?? 500;
          console.log(`📊 Estimated total meetups: ${totalEvents}`);
        }
        const pageEvents = this.extractEventsFromHtml(html);
        consecutiveErrors = 0;
        if (pageEvents.length === 0) {
          console.log(`📭 No events found on page ${currentPage}. This is the last page.`);
          break;
        }
        console.log(`🔍 Found ${pageEvents.length} events on page ${currentPage}`);
        await this.processListingEvents(pageEvents);
        hasMorePages = hasMoreListingPages(html);
        if (!hasMorePages) console.log('🏁 No more pages available.');
        currentPage++;
        await sleep(1000 + Math.floor(Math.random() * 1000));
      } catch (error) {
        consecutiveErrors++;
        console.error(`❌ Error on page ${currentPage}: ${error.message}`);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error(`❌ Too many consecutive errors (${consecutiveErrors}), stopping pagination`);
        } else {
          await sleep(3000);
        }
      }
    }
    console.log(`✅ Completed scraping ${currentPage - 1} pages`);
    this.printStats();
    return this.scrapedEvents;
  }

  /**
   * Resolve each listing row to its real event site, then normalise, filter
   * and collect it. Shared by every page and region.
   */
  async processListingEvents(pageEvents) {
    for (const rawEvent of pageEvents) {
      this.stats.total++;
      if (this.shouldSkipEvent(rawEvent)) continue;

      const devEventsUrl = rawEvent.url;
      if (!isDevEventsUrl(devEventsUrl)) {
        console.log(`⚠️ Skipping event without valid dev.events URL: ${rawEvent.name}`);
        this.stats.failed++;
        continue;
      }
      rawEvent.devEventsUrl = devEventsUrl;
      const { url: actualEventUrl, coverImageUrl, lumaData, meetupData } = await this.extractActualEventUrl(devEventsUrl);
      if (!actualEventUrl) {
        console.log(`⚠️ Could not find actual event URL for: ${rawEvent.name}`);
        this.stats.failed++;
        continue;
      }
      rawEvent.url = actualEventUrl;
      if (coverImageUrl) rawEvent.coverImageUrl = coverImageUrl;
      if (lumaData) rawEvent.lumaData = lumaData;
      if (meetupData) rawEvent.meetupData = meetupData;

      if (isDevEventsUrl(rawEvent.url)) {
        console.log(`🚫 Skipping dev.events URL (extraction failed): ${rawEvent.name} - ${rawEvent.url}`);
        this.stats.failed++;
        continue;
      }
      if (!(await this.validateUrl(rawEvent.url))) continue;

      const normalizedEvent = this.normalizeEvent(rawEvent);
      if (this.isPastEvent(normalizedEvent.eventStart, normalizedEvent.eventEnd)) {
        console.log(`⏰ Skipping past event: ${normalizedEvent.eventTitle} (${normalizedEvent.eventStart})`);
        this.stats.skipped++;
        continue;
      }
      if (this.isPromotionalEvent(normalizedEvent)) {
        console.log(`🚫 Skipping promotional event: ${normalizedEvent.eventTitle}`);
        continue;
      }
      if (normalizedEvent.eventTitle && normalizedEvent.eventLink) {
        this.scrapedEvents.push(normalizedEvent);
        this.processedUrls.add(normalizedEvent.eventLink);
        this.stats.processed++;
      } else {
        this.stats.failed++;
      }
    }
  }

  /**
   * Listing rows → raw events in the shape normalizeEvent expects.
   */
  extractEventsFromHtml(html) {
    const baseUrl = this.config?.config?.baseUrl || 'https://dev.events/meetups';
    return extractListingRows(html, { baseUrl }).map((row) => ({
      name: row.name,
      url: row.url,
      dateText: row.dateText,
      startDate: row.startDate,
      endDate: row.endDate,
      city: row.isOnline ? 'Online' : row.city,
      country: row.isOnline ? '' : row.country,
      region: row.isOnline ? 'Online' : row.region,
      venueAddress: row.venueAddress,
      description: row.description,
      organizer: row.organizer,
    }));
  }

  /**
   * Luma enrichment from the event page's __NEXT_DATA__ (no browser).
   */
  async extractLumaEventData(lumaUrl) {
    try {
      console.log(`🔗 Detected Luma event URL, extracting rich data...`);
      const { status, html } = await fetchHtml(lumaUrl, { allow: LUMA_HOSTS, timeoutMs: 30000, egress: this._egress });
      if (status >= 400) throw new Error(`HTTP ${status}`);
      const lumaData = lumaDataFromNextData(extractNextData(html));
      if (lumaData?.lumaEventId) {
        console.log(`📊 Extracted Luma data: id=${lumaData.lumaEventId}, tz=${lumaData.timezone}, city=${lumaData.city}`);
      }
      return lumaData;
    } catch (error) {
      console.warn(`⚠️ Failed to fetch Luma event data: ${error.message}`);
      return null;
    }
  }

  /**
   * Meetup.com enrichment from the event page's __NEXT_DATA__ (no browser).
   */
  async extractMeetupEventData(meetupUrl) {
    try {
      console.log(`🔗 Detected Meetup.com event URL, extracting rich data...`);
      const { status, html } = await fetchHtml(meetupUrl, { allow: MEETUP_HOSTS, timeoutMs: 30000, egress: this._egress });
      if (status >= 400) throw new Error(`HTTP ${status}`);
      const meetupData = meetupDataFromNextData(extractNextData(html));
      if (meetupData) {
        console.log(`📊 Extracted Meetup data: id=${meetupData.meetupEventId}, city=${meetupData.city}, group=${meetupData.groupName}`);
      }
      return meetupData;
    } catch (error) {
      console.warn(`⚠️ Failed to fetch Meetup event data: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch the dev.events detail page over HTTP and find the event's own
   * site (iframe preview, "Visit" link, or an event-looking external link).
   * Luma and Meetup.com events are enriched from their page's __NEXT_DATA__.
   */
  async extractActualEventUrl(devEventsUrl) {
    try {
      console.log(`🔗 Extracting actual URL from: ${devEventsUrl}`);
      const { status, html } = await fetchHtml(devEventsUrl, { allow: DEV_EVENTS_HOSTS, timeoutMs: 30000, egress: this._egress });
      if (status >= 400) {
        console.error(`❌ Error accessing event page ${devEventsUrl}: HTTP ${status}`);
        return { url: null, coverImageUrl: null, lumaData: null, meetupData: null };
      }
      const detail = extractDetail(html);
      const actualUrl = detail.actualUrl;
      let coverImageUrl = detail.coverImageUrl;
      let lumaData = null;
      let meetupData = null;
      if (actualUrl && isLumaUrl(actualUrl)) {
        lumaData = await this.extractLumaEventData(actualUrl);
        if (!coverImageUrl && lumaData?.coverUrl) coverImageUrl = lumaData.coverUrl;
      } else if (actualUrl && isMeetupUrl(actualUrl)) {
        meetupData = await this.extractMeetupEventData(actualUrl);
      }
      if (actualUrl) {
        console.log(`✅ Successfully extracted URL: ${actualUrl}`);
        return { url: actualUrl, coverImageUrl, lumaData, meetupData };
      }
      console.log(`❌ No actual event URL found in ${devEventsUrl}`);
      return { url: null, coverImageUrl, lumaData: null, meetupData: null };
    } catch (error) {
      console.error(`❌ Error extracting actual URL from ${devEventsUrl}:`, error.message);
      return { url: null, coverImageUrl: null, lumaData: null, meetupData: null };
    }
  }

  /**
   * Enhanced date parsing for meetup events
   */
  parseDateToISO(dateStr) {
    if (!dateStr) {
      return super.parseDateToISO(dateStr);
    }

    try {
      // Handle ISO date format (from JSON-LD)
      // ISO input: take the calendar date as written. Round-tripping through
      // Date/toISOString shifted it by the process timezone, and the old
      // `includes('-')` test also sent "Oct 12-14 26" down this path.
      if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        const isoDate = dateStr.slice(0, 10);
        return {
          eventStart: isoDate,
          eventEnd: isoDate
        };
      }

      // Handle relative dates like "Next Tuesday", "This Friday"
      if (dateStr.toLowerCase().includes('next') || dateStr.toLowerCase().includes('this')) {
        const today = new Date();
        const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

        return {
          eventStart: nextWeek.toISOString().split('T')[0],
          eventEnd: nextWeek.toISOString().split('T')[0]
        };
      }

      // Handle recurring events like "Every Monday"
      if (dateStr.toLowerCase().includes('every')) {
        const today = new Date();
        const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);

        return {
          eventStart: today.toISOString().split('T')[0],
          eventEnd: nextMonth.toISOString().split('T')[0]
        };
      }

      // Fallback to parent implementation
      return super.parseDateToISO(dateStr);

    } catch (error) {
      console.warn(`Meetup date parsing failed for "${dateStr}": ${error.message}`);
      return super.parseDateToISO(dateStr);
    }
  }

  /**
   * Generate unique event ID
   */
  generateEventId(rawEvent) {
    const title = (rawEvent.name || rawEvent.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const url = rawEvent.url || '';
    let hash = 0;
    const source = url || title;
    for (let i = 0; i < source.length; i++) {
      const char = source.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    const hashStr = Math.abs(hash).toString().slice(-4).padStart(4, '0');
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const chars = letters[Math.floor(Math.random() * letters.length)] +
                  letters[Math.floor(Math.random() * letters.length)];
    return chars + hashStr;
  }

  /**
   * Generate unique scraper run ID
   */
  generateRunId() {
    return `meetup_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Check if an event is promotional/advertising content that should be filtered out
   */
  isPromotionalEvent(event) {
    // Common promotional domains and patterns
    const promotionalDomains = [
      'principal.dev',
      'clean-code-developer.com',
      'masterclass.com',
      'coursera.org',
      'udemy.com',
      'pluralsight.com',
      'linkedin.com/learning'
    ];

    // Common promotional keywords in titles
    const promotionalKeywords = [
      'masterclass',
      'course',
      'training',
      'certification',
      'learn',
      'tutorial',
      'bootcamp'
    ];

    if (!event.eventLink) return false;

    try {
      const url = new URL(event.eventLink);

      // Check for promotional domains
      if (promotionalDomains.some(domain => url.hostname.includes(domain))) {
        return true;
      }

      // Check for promotional keywords in titles (case insensitive)
      const title = (event.eventTitle || '').toLowerCase();
      if (promotionalKeywords.some(keyword => title.includes(keyword))) {
        // Additional check: if it's a masterclass or course AND has promotional domain patterns
        if (url.hostname.length < 15 && !url.hostname.includes('conf') && !url.hostname.includes('summit')) {
          return true;
        }
      }

      // Event-hosting platforms are never promotional, whatever their domain
      // shape. Without this, the short-domain heuristic below rejects every
      // luma.com / lu.ma meetup (8 and 5 character hostnames), which is most
      // of what dev.events lists.
      const eventPlatforms = ['luma.com', 'lu.ma', 'meetup.com', 'eventbrite.', 'ti.to', 'tito.io', 'hopin.com', 'zoom.us', 'guild.host', 'bevy.com'];
      if (eventPlatforms.some(p => url.hostname === p || url.hostname.endsWith('.' + p) || url.hostname.includes(p))) {
        return false;
      }

      // Check for very short domain names (often promotional)
      if (url.hostname.split('.').length === 2 && url.hostname.length < 12 &&
          !url.hostname.includes('conf') && !url.hostname.includes('dev') &&
          !url.hostname.includes('tech') && !url.pathname.includes('events')) {
        return true;
      }

    } catch (e) {
      // If URL parsing fails, it might be malformed promotional content
      return true;
    }

    return false;
  }

  /**
   * Extract the dev.events ID from a dev.events URL
   * URLs are like: https://dev.events/conferences/code-mash-2026-eguzf-gg
   * The ID is the last segment after the final hyphen: "eguzf-gg"
   */
  extractDevEventsId(url) {
    if (!isDevEventsUrl(url)) return null;

    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(p => p);

      if (pathParts.length >= 2) {
        // The last path segment contains the event slug with ID
        // e.g., "code-mash-2026-eguzf-gg" -> ID is "eguzf-gg"
        const lastSegment = pathParts[pathParts.length - 1];

        // Match the ID pattern at the end: alphanumeric characters possibly with hyphens
        // Pattern: last 6-12 chars that look like an ID (letters, numbers, hyphens)
        const match = lastSegment.match(/-([a-z0-9]{4,12})$/i);
        if (match) {
          return match[1];
        }
      }
    } catch (e) {
      console.warn(`Failed to extract dev.events ID from ${url}: ${e.message}`);
    }

    return null;
  }

  /**
   * Normalize meetup event data
   */
  normalizeEvent(rawEvent) {
    // The listing's JSON-LD carries unambiguous ISO dates; the <time> text
    // ("Oct 9 26") is only a fallback for rows without it.
    const { eventStart, eventEnd } = rawEvent.startDate
      ? { eventStart: String(rawEvent.startDate).slice(0, 10), eventEnd: String(rawEvent.endDate || rawEvent.startDate).slice(0, 10) }
      : this.parseDateToISO(rawEvent.dateText || rawEvent.date);
    const scraperName = this.config.config?.name || 'DevEventsMeetupScraper';

    // Extract the dev.events ID from the original dev.events URL (stored in devEventsUrl)
    const sourceEventId = this.extractDevEventsId(rawEvent.devEventsUrl);

    // Extract Luma data if available
    const lumaData = rawEvent.lumaData;
    const lumaEventId = lumaData?.lumaEventId || null;
    const lumaPageData = lumaData?.lumaPageData || null;

    // Extract Meetup data if available
    const meetupData = rawEvent.meetupData;
    const meetupEventId = meetupData?.meetupEventId || null;
    const meetupPageData = meetupData?.meetupPageData || null;

    const normalized = {
      eventId: this.generateEventId(rawEvent), // Generate unique event ID
      eventStart,
      eventEnd,
      eventTitle: this.cleanEventTitle(rawEvent.name || rawEvent.title),
      eventLink: rawEvent.url || '',
      eventCity: lumaData?.city || meetupData?.city || rawEvent.city || '',
      eventCountry: lumaData?.country || meetupData?.country || rawEvent.country || '', // Use eventCountry for processing
      eventCountryCode: lumaData?.countryCode || '', // From Luma or will be populated by EventProcessor
      eventRegion: lumaData?.region || meetupData?.state || this.currentRegion || rawEvent.region || '',
      venueAddress: lumaData?.fullAddress || lumaData?.venueAddress || meetupData?.venueAddress || rawEvent.venueAddress || '', // Venue address field
      eventType: 'meetup', // Specific to meetups
      eventTopics: [], // To be filled by topic matching
      sourceEventId: sourceEventId, // dev.events native ID
      lumaEventId: lumaEventId, // Luma event ID (evt-XXX) for registration matching
      meetupEventId: meetupEventId, // Meetup event ID for tracking
      eventTimezone: lumaData?.timezone || meetupData?.timezone || null, // Timezone from Luma or Meetup
      // Full __NEXT_DATA__ JSON from Luma page (refreshed on each scrape)
      lumaPageData: lumaPageData,
      // Full __NEXT_DATA__ JSON from Meetup page (refreshed on each scrape)
      meetupPageData: meetupPageData,
      // New audit fields for scrapers
      scraperName: scraperName,
      scraperRunId: this.generateRunId(),
      source_type: 'scraper',
      source_details: {
        scraper_name: scraperName,
        scraper_run_id: this.generateRunId(),
        original_url: rawEvent.url || null,
        dev_events_url: rawEvent.devEventsUrl || null,
        dev_events_id: sourceEventId,
        luma_event_id: lumaEventId,
        meetup_event_id: meetupEventId,
        scraped_timestamp: new Date().toISOString()
      }
    };

    // Add coordinates from Luma or Meetup data if available
    if (lumaData?.latitude && lumaData?.longitude) {
      normalized.coordinates = { lat: lumaData.latitude, lng: lumaData.longitude };
      normalized.eventLocation = `${lumaData.latitude},${lumaData.longitude}`;
      console.log(`📍 Using coordinates from Luma: ${normalized.eventLocation}`);
    } else if (meetupData?.latitude && meetupData?.longitude) {
      normalized.coordinates = { lat: meetupData.latitude, lng: meetupData.longitude };
      normalized.eventLocation = `${meetupData.latitude},${meetupData.longitude}`;
      console.log(`📍 Using coordinates from Meetup: ${normalized.eventLocation}`);
    }

    // Handle online events
    if (rawEvent.city?.toLowerCase() === 'online' ||
        rawEvent.region?.toLowerCase() === 'online') {
      normalized.eventCity = 'Online';
      normalized.eventCountryCode = '';
      normalized.eventRegion = 'on'; // Use 2-char code for online
    }

    // Extract additional meetup-specific data
    if (rawEvent.organizer) {
      normalized.organizer = rawEvent.organizer;
    }

    if (rawEvent.description) {
      normalized.description = rawEvent.description.substring(0, 500);
    }

    // Include cover image URL if available
    if (rawEvent.coverImageUrl) {
      normalized.coverImageUrl = rawEvent.coverImageUrl;
    }

    return normalized;
  }
}
