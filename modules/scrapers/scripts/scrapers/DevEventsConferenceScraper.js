import { BaseScraper } from './BaseScraper.js';
import { fetchHtml, sleep, extractListingRows, extractListingTotal, hasMoreListingPages, listingPageUrl, extractDetail, extractNextData, lumaDataFromNextData, isLumaUrl, isDevEventsUrl, DEV_EVENTS_HOSTS, LUMA_HOSTS } from './devEventsHttp.js';

/**
 * Scraper for dev.events conferences page
 */
export class DevEventsConferenceScraper extends BaseScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    // Set headless mode (true for production, false for debugging)
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
        // Scrape main conferences page
        await this.scrapePage(this.config.config.baseUrl);
      }

      console.log(`✅ Completed conferences scraping`);

    } catch (error) {
      console.error(`❌ General error in conference scraping: ${error.message}`);
      this.stats.failed++;
    } finally {
      // Save scraped events and cleanup
      await this.saveEvents();
      await this.cleanup();
    }

    // Return the scraped events for API usage
    return this.scrapedEvents;
  }

  /**
   * Scrape a specific region
   */
  async scrapeRegion(region) {
    console.log(`🌍 Scraping region: ${region}`);
    this.currentRegion = region.toLowerCase(); // Store region in lowercase for database
    const regionUrl = `${this.config.config.baseUrl}/${region}`;
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
    const maxPages = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 100;
    let totalEvents = null;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;
    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages && consecutiveErrors < maxConsecutiveErrors && currentPage <= maxPages) {
      const pageUrl = listingPageUrl(baseUrl, currentPage);
      console.log(`📄 Processing page ${currentPage}: ${pageUrl}`);
      try {
        const { status, html } = await fetchHtml(pageUrl, { allow: DEV_EVENTS_HOSTS, timeoutMs: 45000 });
        if (status >= 400) throw new Error(`HTTP ${status} for ${pageUrl}`);
        if (totalEvents === null) {
          totalEvents = extractListingTotal(html) ?? 1000;
          console.log(`📊 Estimated total events: ${totalEvents}`);
        }
        const pageEvents = this.extractEventsFromHtml(html);
        consecutiveErrors = 0;
        if (pageEvents.length === 0) {
          console.log(`📭 No events found on page ${currentPage}. This is the last page.`);
          break;
        }
        console.log(`🔍 Found ${pageEvents.length} events on page ${currentPage}`);
        await this.processListingEvents(pageEvents);
        hasMorePages = hasMoreListingPages(html) && this.stats.processed < totalEvents;
        if (!hasMorePages) console.log('🏁 No more pages available.');
        currentPage++;
        await sleep(1000 + Math.floor(Math.random() * 1000));
      } catch (error) {
        consecutiveErrors++;
        console.error(`❌ Error processing page ${currentPage}: ${error.message}`);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error(`💥 Too many consecutive errors (${consecutiveErrors}). Stopping pagination.`);
        } else {
          currentPage++;
          await sleep((5 + consecutiveErrors * 2) * 1000);
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
      rawEvent.devEventsUrl = devEventsUrl;
      const { url: actualEventUrl, coverImageUrl, lumaData } = await this.extractActualEventUrl(devEventsUrl);
      if (!actualEventUrl) {
        console.log(`⚠️ Could not find actual event URL for: ${rawEvent.name}`);
        this.stats.failed++;
        continue;
      }
      rawEvent.url = actualEventUrl;
      if (coverImageUrl) rawEvent.coverImageUrl = coverImageUrl;
      if (lumaData) rawEvent.lumaData = lumaData;

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
    const baseUrl = this.config?.config?.baseUrl || 'https://dev.events/';
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
    }));
  }

  /**
   * Enhanced date parsing for dev.events format - matches original implementation exactly
   */
  parseDateToISO(dateStr) {
    if (!dateStr) {
      // Always provide a fallback date instead of empty values
      const currentYear = new Date().getFullYear();
      console.warn(`No date provided, using fallback: ${currentYear}-01-01 to ${currentYear}-12-31`);
      return {
        eventStart: `${currentYear}-01-01`,
        eventEnd: `${currentYear}-12-31`
      };
    }

    try {
      // First normalize the value - replace all newlines and extra spaces
      let normalizedDate = dateStr.replace(/\s+/g, ' ').trim();

      // Log the date being processed for debugging
      console.log(`Parsing date: "${normalizedDate}"`);

      // Extract the year
      let yearMatch = normalizedDate.match(/\b(20\d{2})\b/);
      let year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();

      // Handle "Apr 27 - May 2 25" format with two-digit year
      if (/^[A-Za-z]+\s+\d{1,2}\s*-\s*[A-Za-z]+\s+\d{1,2}\s+\d{2}$/.test(normalizedDate)) {
        normalizedDate = normalizedDate.replace(/(\d{2})$/, '20$1');
        console.log(`  Converted two-digit year format to: "${normalizedDate}"`);
        // Re-extract the year after conversion
        yearMatch = normalizedDate.match(/\b(20\d{2})\b/);
        year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
      }

      // Handle "Apr 16 25" format with two-digit year
      if (/^[A-Za-z]+\s+\d{1,2}\s+\d{2}$/.test(normalizedDate)) {
        normalizedDate = normalizedDate.replace(/(\d{2})$/, '20$1');
        console.log(`  Converted two-digit year format to: "${normalizedDate}"`);
        // Re-extract the year after conversion
        yearMatch = normalizedDate.match(/\b(20\d{2})\b/);
        year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
      }

      // Handle "Month Day - Month Day, Year" format (e.g., "Apr 27 - May 2, 2025")
      const crossMonthMatch = normalizedDate.match(/([A-Za-z]+)\s+(\d{1,2})\s*-\s*([A-Za-z]+)\s+(\d{1,2})(?:,\s*|\s+)(20\d{2})/);
      if (crossMonthMatch) {
        const startMonth = this.getMonthNumber(crossMonthMatch[1]);
        const startDay = crossMonthMatch[2].padStart(2, '0');
        const endMonth = this.getMonthNumber(crossMonthMatch[3]);
        const endDay = crossMonthMatch[4].padStart(2, '0');
        const eventYear = crossMonthMatch[5];

        console.log(`  Matched cross-month format: ${eventYear}-${startMonth}-${startDay} to ${eventYear}-${endMonth}-${endDay}`);
        return {
          eventStart: `${eventYear}-${startMonth}-${startDay}`,
          eventEnd: `${eventYear}-${endMonth}-${endDay}`
        };
      }

      // Handle "Month Day-Day, Year" format (e.g., "May 11-13, 2025")
      const rangeMatch = normalizedDate.match(/([A-Za-z]+)\s+(\d{1,2})[-–](\d{1,2})(?:,\s*|\s+)(20\d{2})/);
      if (rangeMatch) {
        const month = this.getMonthNumber(rangeMatch[1]);
        const startDay = rangeMatch[2].padStart(2, '0');
        const endDay = rangeMatch[3].padStart(2, '0');
        const eventYear = rangeMatch[4];

        console.log(`  Matched range format: ${eventYear}-${month}-${startDay} to ${eventYear}-${month}-${endDay}`);
        return {
          eventStart: `${eventYear}-${month}-${startDay}`,
          eventEnd: `${eventYear}-${month}-${endDay}`
        };
      }

      // Handle "Month Day, Year" format (e.g., "May 11, 2025")
      const singleMatch = normalizedDate.match(/([A-Za-z]+)\s+(\d{1,2})(?:,\s*|\s+)(20\d{2})/);
      if (singleMatch) {
        const month = this.getMonthNumber(singleMatch[1]);
        const day = singleMatch[2].padStart(2, '0');
        const eventYear = singleMatch[3];

        console.log(`  Matched single day format: ${eventYear}-${month}-${day}`);
        return {
          eventStart: `${eventYear}-${month}-${day}`,
          eventEnd: `${eventYear}-${month}-${day}`
        };
      }

      // Handle "Apr 30-May 1, 2025" format
      const acrossMonthMatch = normalizedDate.match(/([A-Za-z]+)\s+(\d{1,2})[-–]([A-Za-z]+)\s+(\d{1,2})(?:,\s*|\s+)(20\d{2})/);
      if (acrossMonthMatch) {
        const startMonth = this.getMonthNumber(acrossMonthMatch[1]);
        const startDay = acrossMonthMatch[2].padStart(2, '0');
        const endMonth = this.getMonthNumber(acrossMonthMatch[3]);
        const endDay = acrossMonthMatch[4].padStart(2, '0');
        const eventYear = acrossMonthMatch[5];

        console.log(`  Matched across-month format: ${eventYear}-${startMonth}-${startDay} to ${eventYear}-${endMonth}-${endDay}`);
        return {
          eventStart: `${eventYear}-${startMonth}-${startDay}`,
          eventEnd: `${eventYear}-${endMonth}-${endDay}`
        };
      }

      // Handle date ranges that use unicode dash (e.g., "Apr 22–24, 2025")
      const unicodeDashMatch = normalizedDate.match(/([A-Za-z]+)\s+(\d{1,2})[\u2013\u2014](\d{1,2})(?:,\s*|\s+)(20\d{2})/);
      if (unicodeDashMatch) {
        const month = this.getMonthNumber(unicodeDashMatch[1]);
        const startDay = unicodeDashMatch[2].padStart(2, '0');
        const endDay = unicodeDashMatch[3].padStart(2, '0');
        const eventYear = unicodeDashMatch[4];

        console.log(`  Matched unicode dash range format: ${eventYear}-${month}-${startDay} to ${eventYear}-${month}-${endDay}`);
        return {
          eventStart: `${eventYear}-${month}-${startDay}`,
          eventEnd: `${eventYear}-${month}-${endDay}`
        };
      }

      // Handle "Month Day to Day, Year" format (e.g., "May 11 to 13, 2025")
      const toRangeMatch = normalizedDate.match(/([A-Za-z]+)\s+(\d{1,2})\s+to\s+(\d{1,2})(?:,\s*|\s+)(20\d{2})/);
      if (toRangeMatch) {
        const month = this.getMonthNumber(toRangeMatch[1]);
        const startDay = toRangeMatch[2].padStart(2, '0');
        const endDay = toRangeMatch[3].padStart(2, '0');
        const eventYear = toRangeMatch[4];

        console.log(`  Matched 'to' range format: ${eventYear}-${month}-${startDay} to ${eventYear}-${month}-${endDay}`);
        return {
          eventStart: `${eventYear}-${month}-${startDay}`,
          eventEnd: `${eventYear}-${month}-${endDay}`
        };
      }

      // Handle "Month Day-Day" format without year (e.g., "Jan 29-30", "February 5-7")
      const monthRangeNoYearMatch = normalizedDate.match(/^([A-Za-z]+)\s+(\d{1,2})[-–](\d{1,2})$/);
      if (monthRangeNoYearMatch) {
        const month = this.getMonthNumber(monthRangeNoYearMatch[1]);
        const startDay = monthRangeNoYearMatch[2].padStart(2, '0');
        const endDay = monthRangeNoYearMatch[3].padStart(2, '0');

        // Smart year detection for dates without explicit year
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth() + 1;

        let smartYear = currentYear;
        if ((month === '01' || month === '02') && currentMonth > 2) {
          smartYear = currentYear + 1;
          console.log(`  Smart year detection: Jan/Feb range without explicit year, assuming ${smartYear}`);
        }

        console.log(`  Matched month range without year: ${smartYear}-${month}-${startDay} to ${smartYear}-${month}-${endDay}`);
        return {
          eventStart: `${smartYear}-${month}-${startDay}`,
          eventEnd: `${smartYear}-${month}-${endDay}`
        };
      }

      // Handle "Month Day" format without year (e.g., "Jan 29", "February 5")
      const monthDayNoYearMatch = normalizedDate.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
      if (monthDayNoYearMatch) {
        const month = this.getMonthNumber(monthDayNoYearMatch[1]);
        const day = monthDayNoYearMatch[2].padStart(2, '0');

        // Smart year detection for dates without explicit year
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth() + 1;

        let smartYear = currentYear;
        if ((month === '01' || month === '02') && currentMonth > 2) {
          smartYear = currentYear + 1;
          console.log(`  Smart year detection: Jan/Feb date without explicit year, assuming ${smartYear}`);
        }

        console.log(`  Matched month day without year: ${smartYear}-${month}-${day}`);
        return {
          eventStart: `${smartYear}-${month}-${day}`,
          eventEnd: `${smartYear}-${month}-${day}`
        };
      }

      // Handle when there's just a year
      if (yearMatch) {
        console.log(`  Matched year-only format: ${year}-01-01 to ${year}-12-31`);
        return {
          eventStart: `${year}-01-01`,
          eventEnd: `${year}-12-31`
        };
      }

      // Additional handling for more date formats
      // Handle "DD-DD Month YYYY" format (e.g., "22-24 April 2025")
      const dayMonthYearRangeMatch = normalizedDate.match(/(\d{1,2})[-–](\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})/);
      if (dayMonthYearRangeMatch) {
        const startDay = dayMonthYearRangeMatch[1].padStart(2, '0');
        const endDay = dayMonthYearRangeMatch[2].padStart(2, '0');
        const month = this.getMonthNumber(dayMonthYearRangeMatch[3]);
        const eventYear = dayMonthYearRangeMatch[4];

        console.log(`  Matched DD-DD Month YYYY format: ${eventYear}-${month}-${startDay} to ${eventYear}-${month}-${endDay}`);
        return {
          eventStart: `${eventYear}-${month}-${startDay}`,
          eventEnd: `${eventYear}-${month}-${endDay}`
        };
      }

      // Handle "YYYY-MM-DD - YYYY-MM-DD" format (e.g., "2025-05-22 - 2025-05-24")
      const isoRangeMatch = normalizedDate.match(/(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\s*[-–]\s*(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})/);
      if (isoRangeMatch) {
        const startYear = isoRangeMatch[1];
        const startMonth = isoRangeMatch[2].padStart(2, '0');
        const startDay = isoRangeMatch[3].padStart(2, '0');
        const endYear = isoRangeMatch[4];
        const endMonth = isoRangeMatch[5].padStart(2, '0');
        const endDay = isoRangeMatch[6].padStart(2, '0');

        console.log(`  Matched ISO range format: ${startYear}-${startMonth}-${startDay} to ${endYear}-${endMonth}-${endDay}`);
        return {
          eventStart: `${startYear}-${startMonth}-${startDay}`,
          eventEnd: `${endYear}-${endMonth}-${endDay}`
        };
      }

      // Extract month and day if available, even without a full match
      const monthMatch = normalizedDate.match(/([A-Za-z]{3,})/);
      const dayMatch = normalizedDate.match(/\b(\d{1,2})\b/);

      if (monthMatch && dayMatch) {
        const month = this.getMonthNumber(monthMatch[1]);
        const day = dayMatch[1].padStart(2, '0');

        // Smart year detection: if no explicit year was found and we're dealing with
        // Jan/Feb events while we're past those months in the current year,
        // assume it's for next year
        let smartYear = year;
        if (!yearMatch) { // No explicit year was found in the original date
          const currentDate = new Date();
          const currentYear = currentDate.getFullYear();
          const currentMonth = currentDate.getMonth() + 1; // getMonth() returns 0-11

          // If the event is in Jan/Feb and we're past Feb in the current year,
          // it's likely for next year
          if ((month === '01' || month === '02') && currentMonth > 2) {
            smartYear = (currentYear + 1).toString();
            console.log(`  Smart year detection: Jan/Feb event without explicit year, assuming ${smartYear}`);
          } else {
            smartYear = currentYear.toString();
          }
        }

        // Check if this might be a multi-day event by looking for common range indicators
        if (normalizedDate.includes('-') || normalizedDate.includes('–') ||
            normalizedDate.includes('to') || normalizedDate.includes('through')) {

          // Try to extract a range of days
          const dayRangeMatch = normalizedDate.match(/\b(\d{1,2})(?:\s*[-–]\s*|\s+to\s+|\s+through\s+)(\d{1,2})\b/);
          if (dayRangeMatch) {
            const startDay = dayRangeMatch[1].padStart(2, '0');
            const endDay = dayRangeMatch[2].padStart(2, '0');

            console.log(`  Extracted day range: ${smartYear}-${month}-${startDay} to ${smartYear}-${month}-${endDay}`);
            return {
              eventStart: `${smartYear}-${month}-${startDay}`,
              eventEnd: `${smartYear}-${month}-${endDay}`
            };
          }
        }

        console.log(`  Extracted partial date components: ${smartYear}-${month}-${day}`);
        return {
          eventStart: `${smartYear}-${month}-${day}`,
          eventEnd: `${smartYear}-${month}-${day}`
        };
      }

      // As a last resort, use the current year with a full-year range
      console.warn(`  Could not parse date "${normalizedDate}" with existing patterns. Using year-only fallback.`);

      // Apply smart year detection for fallback case too
      let fallbackYear = year;
      if (!yearMatch) { // No explicit year was found in the original date
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        // For unknown dates without explicit years, use current year
        fallbackYear = currentYear.toString();
      }

      return {
        eventStart: `${fallbackYear}-01-01`,
        eventEnd: `${fallbackYear}-12-31`
      };
    } catch (error) {
      console.warn(`Warning: Error parsing date "${dateStr}": ${error.message}. Using current year fallback.`);
      const currentYear = new Date().getFullYear();
      return {
        eventStart: `${currentYear}-01-01`,
        eventEnd: `${currentYear}-12-31`
      };
    }
  }

  /**
   * Helper function to get month number from month name
   */
  getMonthNumber(monthName) {
    const months = {
      'jan': '01', 'january': '01',
      'feb': '02', 'february': '02',
      'mar': '03', 'march': '03',
      'apr': '04', 'april': '04',
      'may': '05',
      'jun': '06', 'june': '06',
      'jul': '07', 'july': '07',
      'aug': '08', 'august': '08',
      'sep': '09', 'september': '09',
      'oct': '10', 'october': '10',
      'nov': '11', 'november': '11',
      'dec': '12', 'december': '12'
    };

    return months[monthName.toLowerCase()] || '01';
  }

  /**
   * Clean event title by removing years, excessive whitespace, and normalizing format
   * but preserving suffixes and edition numbers - matches original implementation
   */
  cleanEventTitle(title) {
    if (!title) return '';

    let cleanTitle = title;

    // Remove year patterns (2023, 2024, 2025, etc.)
    cleanTitle = cleanTitle.replace(/\s+20\d{2}\b/g, '');
    cleanTitle = cleanTitle.replace(/20\d{2}$/g, '');

    // DO NOT remove common event name suffixes (preserving conference, event, summit, etc.)
    // DO NOT remove edition numbers (preserving 3rd, 10th, etc.)

    // Remove parenthesized content (e.g., "(Online)", "(Virtual)", etc.)
    cleanTitle = cleanTitle.replace(/\([^)]*\)/g, '');

    // Remove special characters and normalize spaces
    cleanTitle = cleanTitle.replace(/[:#]/g, '');
    cleanTitle = cleanTitle.replace(/\s+/g, ' ');

    return cleanTitle.trim();
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
      // luma.com / lu.ma event (8 and 5 character hostnames).
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
   * Normalize event data - override to use our custom cleanEventTitle
   */
  normalizeEvent(rawEvent) {
    // The listing's JSON-LD carries unambiguous ISO dates; the <time> text
    // ("Oct 9-10 26") is only a fallback for rows without it.
    const { eventStart, eventEnd } = rawEvent.startDate
      ? { eventStart: String(rawEvent.startDate).slice(0, 10), eventEnd: String(rawEvent.endDate || rawEvent.startDate).slice(0, 10) }
      : this.parseDateToISO(rawEvent.dateText || rawEvent.date);
    const scraperName = this.config.config?.name || 'DevEventsConferenceScraper';

    // Extract the dev.events ID from the original dev.events URL (stored in devEventsUrl)
    const sourceEventId = this.extractDevEventsId(rawEvent.devEventsUrl);

    // Extract Luma data if available
    const lumaData = rawEvent.lumaData;
    const lumaEventId = lumaData?.lumaEventId || null;

    const normalized = {
      eventId: this.generateEventId(rawEvent), // Generate unique event ID
      eventStart,
      eventEnd,
      eventTitle: this.cleanEventTitle(rawEvent.name || rawEvent.title),
      eventLink: rawEvent.url || '',
      eventCity: lumaData?.city || rawEvent.city || '',
      eventCountry: lumaData?.country || rawEvent.country || '', // Use eventCountry for processing
      eventCountryCode: lumaData?.countryCode || '', // From Luma or will be populated by EventProcessor
      eventRegion: lumaData?.region || this.currentRegion || rawEvent.region || '',
      venueAddress: lumaData?.fullAddress || lumaData?.venueAddress || rawEvent.venueAddress || '', // Venue address field
      eventType: this.config.config?.type || 'conference', // conference or meetup
      eventTopics: [], // To be filled by topic matching
      sourceEventId: sourceEventId, // dev.events native ID
      lumaEventId: lumaEventId, // Luma event ID (evt-XXX) for registration matching
      eventTimezone: lumaData?.timezone || null, // Timezone from Luma
      // New audit fields for scrapers
      scraperName: scraperName,
      scraperRunId: this.generateRunId(),
      source_type: 'scraper',
      source_details: {
        scraper_name: scraperName,
        scraper_type: 'conference',
        base_url: this.config.config?.baseUrl,
        dev_events_url: rawEvent.devEventsUrl || null,
        dev_events_id: sourceEventId,
        luma_event_id: lumaEventId,
        scraped_timestamp: new Date().toISOString(),
        raw_data_hash: this.hashRawData(rawEvent)
      },
      rawData: rawEvent // Keep original for debugging
    };

    // Add coordinates from Luma data if available
    if (lumaData?.latitude && lumaData?.longitude) {
      normalized.coordinates = { lat: lumaData.latitude, lng: lumaData.longitude };
      normalized.eventLocation = `${lumaData.latitude},${lumaData.longitude}`;
      console.log(`📍 Using coordinates from Luma: ${normalized.eventLocation}`);
    }

    // Include cover image URL if available
    if (rawEvent.coverImageUrl) {
      normalized.coverImageUrl = rawEvent.coverImageUrl;
    }

    // Handle online events
    if (rawEvent.city?.toLowerCase() === 'online' ||
        rawEvent.region?.toLowerCase() === 'online') {
      normalized.eventCity = 'Online';
      normalized.eventCountryCode = '';
      normalized.eventRegion = 'on'; // Use 2-char code for online
    }

    return normalized;
  }

  /**
   * Generate a unique event ID based on event data
   */
  generateEventId(rawEvent) {
    // Create a deterministic but unique ID based on event URL and title
    const title = (rawEvent.name || rawEvent.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const url = rawEvent.url || '';

    // Extract a hash from the URL or title for uniqueness
    let hash = 0;
    const source = url || title;
    for (let i = 0; i < source.length; i++) {
      const char = source.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Convert to positive number and get last 4 digits
    const hashStr = Math.abs(hash).toString().slice(-4).padStart(4, '0');

    // Generate a 6-character ID: 2 letters + 4 numbers
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const chars = letters[Math.floor(Math.random() * letters.length)] +
                  letters[Math.floor(Math.random() * letters.length)];

    return chars + hashStr;
  }

  /**
   * Generate a unique run ID for this scraping session
   */
  generateRunId() {
    if (!this.runId) {
      this.runId = `DevEventsConf_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    }
    return this.runId;
  }

  /**
   * Create a simple hash of raw event data for change tracking
   */
  hashRawData(rawEvent) {
    const dataString = JSON.stringify({
      name: rawEvent.name || rawEvent.title,
      url: rawEvent.url,
      date: rawEvent.dateText || rawEvent.date,
      city: rawEvent.city,
      country: rawEvent.country
    });

    // Simple hash function for tracking data changes
    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
      const char = dataString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }

  /**
   * Luma enrichment from the event page's __NEXT_DATA__ (no browser).
   */
  async extractLumaEventData(lumaUrl) {
    try {
      console.log(`🔗 Detected Luma event URL, extracting rich data...`);
      const { status, html } = await fetchHtml(lumaUrl, { allow: LUMA_HOSTS, timeoutMs: 30000 });
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
   * Fetch the dev.events detail page over HTTP and find the event's own
   * site (iframe preview, "Visit" link, or an event-looking external link).
   * Luma-hosted events are enriched from the Luma page's __NEXT_DATA__.
   */
  async extractActualEventUrl(devEventsUrl) {
    try {
      console.log(`🔗 Extracting actual URL from: ${devEventsUrl}`);
      const { status, html } = await fetchHtml(devEventsUrl, { allow: DEV_EVENTS_HOSTS, timeoutMs: 30000 });
      if (status >= 400) {
        console.error(`❌ Error accessing event page ${devEventsUrl}: HTTP ${status}`);
        return { url: null, coverImageUrl: null, lumaData: null };
      }
      const detail = extractDetail(html);
      const actualUrl = detail.actualUrl;
      let coverImageUrl = detail.coverImageUrl;
      let lumaData = null;
      if (actualUrl && isLumaUrl(actualUrl)) {
        lumaData = await this.extractLumaEventData(actualUrl);
        if (!coverImageUrl && lumaData?.coverUrl) coverImageUrl = lumaData.coverUrl;
      }
      if (actualUrl) {
        console.log(`✅ Successfully extracted URL: ${actualUrl}`);
        return { url: actualUrl, coverImageUrl, lumaData };
      }
      console.log(`❌ No actual event URL found in ${devEventsUrl}`);
      return { url: null, coverImageUrl, lumaData: null };
    } catch (error) {
      console.error(`❌ Error extracting actual URL from ${devEventsUrl}:`, error.message);
      return { url: null, coverImageUrl: null, lumaData: null };
    }
  }
}
