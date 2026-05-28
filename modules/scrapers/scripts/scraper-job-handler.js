/**
 * Scraper Job Handler
 *
 * Core scraper job logic extracted from scraper-worker.js for use with BullMQ.
 * This module provides the runScraperJob function that runs a scraper job
 * and uses a provided logger for output (which publishes to Redis for SSE).
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DevEventsConferenceScraper } from './scrapers/DevEventsConferenceScraper.js';
import { DevEventsMeetupScraper } from './scrapers/DevEventsMeetupScraper.js';
import { LumaEventsScraper } from './scrapers/LumaEventsScraper.js';
import { LumaICalScraper } from './scrapers/LumaICalScraper.js';
import { LumaSearchScraper } from './scrapers/LumaSearchScraper.js';
import { LumaCategoryScraper } from './scrapers/LumaCategoryScraper.js';
import { LumaHostEnricher } from './scrapers/LumaHostEnricher.js';
import { LumaICalScraperFast } from './scrapers/LumaICalScraperFast.js';
import { LumaSearchScraperFast } from './scrapers/LumaSearchScraperFast.js';
import { LumaCategoryScraperFast } from './scrapers/LumaCategoryScraperFast.js';
import { LinuxFoundationEventsScraper } from './scrapers/LinuxFoundationEventsScraper.js';
import { TopicMatcher } from './scrapers/TopicMatcher.js';
import { GeocodingService } from './scrapers/GeocodingService.js';
import { EventProcessor } from './scrapers/EventProcessor.js';
import {
  extractHostsFromLumaData,
  extractLumaCountsFromLumaData,
  upsertHosts,
} from './lib/luma-extractor.js';
import { processLumaContentInline } from './lib/luma-content-processor.js';
import { populateLumaCalendarCoverIfMissing } from './lib/luma-calendar-cover.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// These are injected by the caller (job-worker.js) to avoid cross-repo imports
let _supabase = null;
let _addJob = null;
let _JobTypes = null;

/**
 * Initialize the handler with external dependencies.
 * Called once by job-worker.js at startup.
 */
export function initScraperHandler({ supabase, addJob, JobTypes }) {
  _supabase = supabase;
  _addJob = addJob;
  _JobTypes = JobTypes;
}

function getSupabase() {
  if (!_supabase) throw new Error('Scraper handler not initialized — call initScraperHandler() first');
  return _supabase;
}

// Cached calendar-linker module — used by the lazy-creation path in the
// event link block below. Lives in scripts/lib/, ESM. Cached to avoid
// re-importing on every event save.
let _calendarLinker = null;
async function getCalendarLinker() {
  if (_calendarLinker) return _calendarLinker;
  try {
    _calendarLinker = await import('./lib/calendar-linker.js');
  } catch {
    _calendarLinker = null;
  }
  return _calendarLinker;
}

// In-memory negative cache so we don't re-query the scrapers table on
// every event save when the same scraper has already been ruled out
// (non-Luma type, no resolvable slug, etc). Per-process — fine because
// the handler runs in long-lived workers and the set stays tiny
// (one entry per active scraper).
const _scraperCalendarMissCache = new Set();

/**
 * Find or lazily create the calendar that belongs to the given scraper.
 *
 * Replaces the previous design where calendars were eagerly materialised
 * at scraper-creation time (POST /api/scrapers, LumaSearch/LumaCategory
 * auto-discovery), which left empty calendar shells behind for any
 * scraper that never produced events. Now: a scraper has no calendar
 * until its first event lands and gets here.
 *
 * Idempotent — ensureCalendarForScraper itself dedupes on
 * luma_calendar_id and slug. Returns the calendar UUID or null when no
 * calendar can be derived (non-Luma scraper, missing slug, etc.).
 */
async function findOrCreateCalendarForScraper(scraperId) {
  if (!scraperId) return null;

  // 1. Existing calendar?
  const { data: existing } = await getSupabase()
    .from('calendars')
    .select('id')
    .eq('default_scraper_id', scraperId)
    .maybeSingle();
  if (existing?.id) {
    // Best-effort backfill of the calendar header image from the Luma page.
    // No-op if cover_image_url is already set or the calendar isn't a Luma
    // calendar; per-process cached so a 100-event scrape only fetches once.
    populateLumaCalendarCoverIfMissing(getSupabase(), existing.id).catch(() => {});
    return existing.id;
  }

  // 2. Negative cache — already tried and gave up.
  if (_scraperCalendarMissCache.has(scraperId)) return null;

  // 3. Fetch the scraper + try to derive Luma calendar info from it.
  const { data: scraper } = await getSupabase()
    .from('scrapers')
    .select('id, name, scraper_type, base_url, config')
    .eq('id', scraperId)
    .maybeSingle();
  if (!scraper || scraper.scraper_type !== 'LumaICalScraper') {
    _scraperCalendarMissCache.add(scraperId);
    return null;
  }

  const linker = await getCalendarLinker();
  if (!linker) {
    _scraperCalendarMissCache.add(scraperId);
    return null;
  }
  const calendarInfo = await linker.resolveLumaCalendarFromScraper(scraper);
  if (!calendarInfo?.slug) {
    _scraperCalendarMissCache.add(scraperId);
    return null;
  }

  // 4. Create.
  const result = await linker.ensureCalendarForScraper(
    getSupabase(),
    scraper,
    calendarInfo,
    { source: 'lazy-on-first-event' },
  );
  if (result?.calendarId) {
    populateLumaCalendarCoverIfMissing(getSupabase(), result.calendarId, { slug: calendarInfo.slug }).catch(() => {});
  }
  return result?.calendarId ?? null;
}

// Scraper class mapping
const scraperClasses = {
  'DevEventsConferenceScraper': DevEventsConferenceScraper,
  'DevEventsMeetupScraper': DevEventsMeetupScraper,
  'LumaEventsScraper': LumaEventsScraper,
  'LumaICalScraper': LumaICalScraper,
  'LumaSearchScraper': LumaSearchScraper,
  'LumaCategoryScraper': LumaCategoryScraper,
  'LumaHostEnricher': LumaHostEnricher,
  // Fast variants — route per-event-page fetches through scrapling-fetcher.
  // See spec-scrapling-fetcher-service.md §4.3.
  'LumaICalScraperFast': LumaICalScraperFast,
  'LumaSearchScraperFast': LumaSearchScraperFast,
  'LumaCategoryScraperFast': LumaCategoryScraperFast,
  // events.linuxfoundation.org listing scraper. Pure HTTP (via
  // scrapling-fetcher when configured); parses the WordPress card
  // markup + drills into each event's detail page for full enrichment.
  'LinuxFoundationEventsScraper': LinuxFoundationEventsScraper,
};

// Region mapping helper
function mapRegionToCode(regionName) {
  if (!regionName) return '';
  if (regionName.length === 2) return regionName.toLowerCase();

  const regionMap = {
    "Asia": "as", "Africa": "af", "Europe": "eu",
    "North America": "na", "South America": "sa", "Oceania": "oc",
    "Online": "on", "Central America": "na", "Caribbean": "na",
    "Middle East": "as", "Eastern Europe": "eu", "Western Europe": "eu",
    "Northern Europe": "eu", "Southern Europe": "eu", "Southeast Asia": "as",
    "East Asia": "as", "South Asia": "as", "Central Asia": "as",
    "North Africa": "af", "Sub-Saharan Africa": "af", "West Africa": "af",
    "East Africa": "af", "Southern Africa": "af", "Central Africa": "af",
    "Nordic": "eu", "Baltic": "eu", "Balkan": "eu", "Scandinavia": "eu",
    "APAC": "as", "EMEA": "eu", "LATAM": "sa"
  };

  return regionMap[regionName] || '';
}

// Generate 6-character event ID
function generateEventId(existingIds = new Set()) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  let id;

  do {
    id = '';
    const letterCount = 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < letterCount; i++) {
      id += letters[Math.floor(Math.random() * letters.length)];
    }
    const remainingChars = 6 - letterCount;
    for (let i = 0; i < remainingChars; i++) {
      id += numbers[Math.floor(Math.random() * numbers.length)];
    }
    id = id.split('').sort(() => Math.random() - 0.5).join('');
  } while (existingIds.has(id));

  return id;
}

// Determine event status based on completeness
function determineEventStatus(event) {
  const hasStartTime = event.event_start && event.event_start !== '';
  const hasEndTime = event.event_end && event.event_end !== '';
  const hasLocation = event.event_city && event.event_city !== '';
  const hasLink = event.event_link && event.event_link !== '';

  if (hasStartTime && hasEndTime && hasLocation && hasLink) {
    return 'complete';
  } else {
    return 'incomplete';
  }
}

// Setup job-specific temporary directory
function setupJobDirectory(jobId) {
  const scriptDir = path.resolve(__dirname, '..');
  const jobTempDir = path.join(scriptDir, 'temp', `job-${jobId}`);

  if (!fs.existsSync(jobTempDir)) {
    fs.mkdirSync(jobTempDir, { recursive: true });
  }

  return {
    jobTempDir,
    outputPath: path.join(jobTempDir, 'scraped-events.json'),
    processedEventsPath: path.join(jobTempDir, 'processed-events.json'),
    geocodingCachePath: path.join(jobTempDir, 'geocoding-cache.json')
  };
}

// Cleanup job directory
function cleanupJobDirectory(jobTempDir) {
  try {
    if (fs.existsSync(jobTempDir)) {
      fs.rmSync(jobTempDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`Failed to cleanup temp directory: ${error.message}`);
  }
}

// Update job status in database
async function updateJobStatus(jobId, status, stats = {}) {
  try {
    const params = {
      job_id: jobId,
      new_status: status
    };

    if (status === 'completed' || status === 'failed') {
      params.items_found_count = stats.found || stats.total || 0;
      params.items_processed_count = stats.processed || 0;
      params.items_skipped_count = stats.skipped || 0;
      params.items_failed_count = stats.failed || 0;

      if (status === 'failed' && stats.error) {
        params.error_msg = stats.error;
      }
    }

    const { error } = await getSupabase().rpc('scrapers_update_job', params);

    if (error) {
      console.error(`Failed to update job status: ${error.message}`);
    }
  } catch (error) {
    console.error(`Failed to update job status: ${error.message}`);
  }
}

/**
 * Run a scraper job
 * @param {number} jobId - The scraper_jobs database ID
 * @param {object} logger - Logger object with log, progress, complete, error methods
 * @param {object} bullmqJob - The BullMQ job object (for heartbeat/progress updates)
 * @returns {object} Result with stats
 */
export async function runScraperJob(jobId, logger, bullmqJob = null) {
  let jobTempDir = null;
  let scraper = null;
  let heartbeatInterval = null;

  try {
    logger.log(`🔧 Starting scraper job ${jobId}`);

    // Update job status to running
    await updateJobStatus(jobId, 'running');

    // Set initial heartbeat and timeout_at
    try {
      await getSupabase().rpc('scrapers_heartbeat', { p_job_id: jobId });
    } catch (e) { /* heartbeat RPC may not exist yet during migration */ }

    // Start heartbeat interval (every 60s)
    heartbeatInterval = setInterval(async () => {
      try {
        await getSupabase().rpc('scrapers_heartbeat', {
          p_job_id: jobId,
          p_metadata: scraper ? JSON.stringify(scraper.stats || {}) : null
        });
        if (bullmqJob) {
          await bullmqJob.updateProgress(scraper?.stats || { heartbeat: Date.now() });
        }
      } catch (e) { /* non-fatal */ }
    }, 60000);

    // Get job details from database
    logger.log(`📊 Fetching job details from database...`);
    const { data: jobData, error: jobError } = await getSupabase().rpc('scrapers_get_job', {
      job_id: jobId
    });

    if (jobError || !jobData || jobData.length === 0) {
      // Job was deleted from database - log and skip gracefully (don't retry)
      logger.log(`⚠️ Job ${jobId} not found in database - may have been deleted. Skipping.`);
      const skipError = new Error(`Job not found in database: ${jobId} - skipping`);
      skipError.skipRetry = true; // Signal to not retry this job
      throw skipError;
    }

    const job = jobData[0];
    logger.log(`✅ Job loaded: ${job.scraper_name} (${job.event_type})`);

    // Get scraper configuration
    const { data: scraperData } = await getSupabase()
      .from('scrapers')
      .select('*')
      .eq('id', job.scraper_id)
      .single();

    if (!scraperData) {
      throw new Error('Scraper configuration not found');
    }

    logger.log(`📋 Scraper config loaded: ${scraperData.name}`);

    // Setup job-specific directory
    const paths = setupJobDirectory(jobId);
    jobTempDir = paths.jobTempDir;
    logger.log(`📁 Created job temp directory: ${jobTempDir}`);

    // Initialize scraper class
    const ScraperClass = scraperClasses[scraperData.scraper_type];
    if (!ScraperClass) {
      throw new Error(`Unknown scraper type: ${scraperData.scraper_type}`);
    }

    const scriptDir = path.resolve(__dirname, '..');

    const scraperConfig = {
      id: scraperData.id,
      name: scraperData.name,
      description: scraperData.description,
      type: scraperData.event_type,
      url: scraperData.base_url,
      base_url: scraperData.base_url,
      config: {
        ...scraperData.config || {},
        baseUrl: scraperData.base_url,
        name: scraperData.name,
        account: scraperData.account || (scraperData.config || {}).account || null
      }
    };

    const globalConfig = {
      outputPath: paths.outputPath,
      processedEventsPath: paths.processedEventsPath,
      urlValidation: {
        enabled: true,
        timeout: 10000
      },
      database: {
        supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
        supabaseKey: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
        tableName: 'events'
      },
      // Pass the service-role Supabase client so scrapers that need to
      // create/mutate module-level state (e.g. LumaSearchScraper auto-creating
      // iCal scrapers) can do so directly.
      supabase: getSupabase(),
      topicsPath: path.resolve(__dirname, 'scrapers', 'topics.json'),
      geocoding: {
        cachePath: paths.geocodingCachePath,
        enabled: true
      }
    };

    // Initialize processing services
    const topicMatcher = new TopicMatcher(globalConfig.topicsPath);
    const geocodingService = new GeocodingService(globalConfig.geocoding);
    const eventProcessor = new EventProcessor(scriptDir);

    scraper = new ScraperClass(scraperConfig, globalConfig);

    // Pass geocoding service to scraper if supported
    if (scraper && typeof scraper === 'object') {
      scraper.geocodingService = geocodingService;
      // Make the logger available to scrapers that want to use it directly
      scraper.logger = logger;
    }

    logger.log(`🔧 Scraper initialized: ${scraperData.scraper_type}`);
    logger.log(`📋 Event processor ready: ${eventProcessor.getStats().countryCodesLoaded} countries, ${eventProcessor.getStats().regionsSupported.length} regions`);

    // Counters are hoisted above the scrape call so processAndSaveEvent (defined
    // next) can increment them when scrapers stream saves during their scrape phase.
    let processedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let filteredCount = 0;

    // Collected for the bulk scraper:speaker-extract job we enqueue at
    // the end of the run. Each entry is a successfully-saved event UUID
    // that needs Anthropic-driven speaker extraction.
    const speakerExtractEventUuids = [];

    // processAndSaveEvent — single source of truth for the per-event save pipeline.
    // Called two ways:
    //   1. STREAMING: scrapers call globalConfig.saveEvent(event) as each event
    //      is parsed-and-filtered, so crashes mid-scrape don't lose prior work.
    //   2. BATCH: after scraper.scrape() returns, we loop over any events still
    //      in the returned array and call this function directly. Non-streaming
    //      scrapers (and any events a streaming scraper couldn't persist itself)
    //      flow through this path.
    // KEYWORD FILTERING: this function does NOT re-check keyword filters — that
    // is the scraper's responsibility BEFORE it decides to save an event. We
    // trust the caller to have filtered. We only apply eventProcessor.shouldFilterOut
    // which catches malformed rows (bad URLs, known-bad titles).
    const processAndSaveEvent = async (event) => {
      try {
        // Filter out unwanted events
        if (eventProcessor.shouldFilterOut(event)) {
          filteredCount++;
          logger.log(`⏭️ Filtered: ${event.eventTitle}`);
          return { status: 'filtered' };
        }

        // Process event
        const cleanedEvent = eventProcessor.processEvent(event);

        // Match topics
        const contentForMatching = cleanedEvent.eventTitle + ' ' +
          (cleanedEvent.description || '') + ' ' +
          (cleanedEvent.pageContent || '');
        cleanedEvent.eventTopics = await topicMatcher.matchTopics(contentForMatching);

        // Geocode if needed (skip if scraper already provided coordinates, e.g., from Luma)
        if (cleanedEvent.coordinates || cleanedEvent.eventLocation) {
          if (cleanedEvent.coordinates) {
            cleanedEvent.latitude = cleanedEvent.coordinates.lat;
            cleanedEvent.longitude = cleanedEvent.coordinates.lng;
            logger.log(`📍 Using coordinates from scraper: ${cleanedEvent.coordinates.lat},${cleanedEvent.coordinates.lng}`);
          }
        } else if (geocodingService && cleanedEvent.eventCity && cleanedEvent.eventCity.toLowerCase() !== 'online') {
          const coordinates = await geocodingService.geocode(
            cleanedEvent.eventCity,
            cleanedEvent.eventCountryCode
          );
          if (coordinates) {
            cleanedEvent.latitude = coordinates.lat;
            cleanedEvent.longitude = coordinates.lng;
            cleanedEvent.eventLocation = `${coordinates.lat},${coordinates.lng}`;
          }
        }

        // Save to database
        try {
          const existingEventUuid = await eventProcessor.isDuplicate(cleanedEvent, getSupabase());
          const isUpdate = existingEventUuid !== null;

          let eventId = cleanedEvent.eventId || cleanedEvent.event_id;
          if (isUpdate) {
            const { data: existingEvent } = await getSupabase()
              .from('events')
              .select('event_id')
              .eq('id', existingEventUuid)
              .single();
            if (existingEvent) {
              eventId = existingEvent.event_id;
            } else {
              logger.log(`⚠️ Could not find existing event with UUID ${existingEventUuid}`, 'warn');
            }
          } else {
            if (!eventId || eventId.length > 6) {
              const { data: existingEvents } = await getSupabase()
                .from('events')
                .select('event_id');
              const existingIds = new Set(existingEvents?.map(e => e.event_id) || []);
              eventId = generateEventId(existingIds);
            }
          }

          let screenshotUrl = null;
          let screenshotGeneratedAt = null;

          if (cleanedEvent.coverImageUrl) {
            try {
              const fetch = (await import('node-fetch')).default;
              const response = await fetch(cleanedEvent.coverImageUrl);
              if (response.ok) {
                const imageBuffer = Buffer.from(await response.arrayBuffer());
                let fileExtension = 'jpg';
                const contentType = response.headers.get('content-type');
                if (contentType) {
                  if (contentType.includes('png')) fileExtension = 'png';
                  else if (contentType.includes('webp')) fileExtension = 'webp';
                }
                const eventImageServicePath = process.env.EVENT_IMAGE_SERVICE_PATH
                  || '/app/scripts/event-image-service.js';
                const { uploadEventImage } = await import(eventImageServicePath);
                const uploadResult = await uploadEventImage(imageBuffer, eventId, fileExtension);
                if (uploadResult.success) {
                  screenshotUrl = uploadResult.url;
                  screenshotGeneratedAt = new Date().toISOString();
                }
              }
            } catch (error) {
              logger.log(`⚠️ Failed to upload cover image: ${error.message}`, 'warn');
            }
          }

          const dbEvent = {
            event_id: eventId,
            event_title: cleanedEvent.eventTitle || cleanedEvent.event_title,
            event_city: cleanedEvent.eventCity || cleanedEvent.event_city,
            event_country_code: (cleanedEvent.eventCountryCode && cleanedEvent.eventCountryCode.length <= 2) ? cleanedEvent.eventCountryCode : '',
            event_region: mapRegionToCode(cleanedEvent.eventRegion),
            event_link: cleanedEvent.eventLink || cleanedEvent.event_link,
            event_start: cleanedEvent.eventStart || cleanedEvent.event_start,
            event_end: cleanedEvent.eventEnd || cleanedEvent.event_end,
            event_type: cleanedEvent.eventType || cleanedEvent.event_type,
            event_topics: cleanedEvent.eventTopics || cleanedEvent.event_topics || [],
            source_type: 'scraper',
            // Run-bookkeeping is the floor; per-scraper sourceDetails (e.g.
            // LinuxFoundationEventsScraper's action_links, wp_post_id) is
            // merged on top so scrapers can attach arbitrary structured
            // data without losing the bookkeeping fields downstream code
            // (admin event-detail page, comparison view) reads.
            source_details: {
              scraper_name: cleanedEvent.scraperName || job.scraper_name || 'worker_scraper',
              api_endpoint: '/api/scrapers',
              scraped_timestamp: new Date().toISOString(),
              job_id: jobId,
              ...(cleanedEvent.sourceDetails || cleanedEvent.source_details || {}),
            },
            luma_event_id: cleanedEvent.lumaEventId || cleanedEvent.luma_event_id || null,
            source_event_id: cleanedEvent.sourceEventId || cleanedEvent.source_event_id || null,
            event_timezone: cleanedEvent.eventTimezone || cleanedEvent.event_timezone || null,
            event_location: cleanedEvent.eventLocation || cleanedEvent.event_location || null,
            luma_page_data: cleanedEvent.lumaPageData || cleanedEvent.luma_page_data || null,
            meetup_page_data: cleanedEvent.meetupPageData || cleanedEvent.meetup_page_data || null
          };

          dbEvent.status = determineEventStatus(dbEvent);

          let error;
          let newEventUuid;
          if (isUpdate) {
            const updateParams = {
              p_id: existingEventUuid,
              p_event_title: dbEvent.event_title,
              p_listing_intro: null,
              p_offer_result: null,
              p_offer_close_display: null,
              p_event_topics: dbEvent.event_topics || null,
              p_offer_ticket_details: null,
              p_offer_value: null,
              p_event_city: dbEvent.event_city,
              p_event_country_code: dbEvent.event_country_code,
              p_event_link: dbEvent.event_link,
              p_event_logo: null,
              p_offer_slug: null,
              p_offer_close_date: null,
              p_event_start: dbEvent.event_start,
              p_event_end: dbEvent.event_end,
              p_event_region: dbEvent.event_region,
              p_event_location: dbEvent.event_location || cleanedEvent.eventLocation || null,
              p_event_topics_updated_at: null,
              p_event_type: dbEvent.event_type,
              p_venue_address: cleanedEvent.venueAddress || null,
              p_scraped_by: cleanedEvent.scraperName || job.scraper_name || 'worker_scraper',
              p_scraper_id: job.scraper_id,
              p_source_type: dbEvent.source_type,
              p_source_details: dbEvent.source_details,
              p_event_timezone: dbEvent.event_timezone || null,
              p_luma_event_id: dbEvent.luma_event_id,
              p_source_event_id: dbEvent.source_event_id,
              p_luma_page_data: dbEvent.luma_page_data,
              p_meetup_page_data: dbEvent.meetup_page_data,
              p_content_category: scraperData.content_category || null
            };
            const result = await getSupabase().rpc('events_update', updateParams);
            error = result.error;
          } else {
            const createParams = {
              p_event_id: dbEvent.event_id,
              p_event_title: dbEvent.event_title,
              p_listing_intro: null,
              p_offer_result: null,
              p_offer_close_display: null,
              p_event_topics: dbEvent.event_topics || null,
              p_offer_ticket_details: null,
              p_offer_value: null,
              p_event_city: dbEvent.event_city,
              p_event_country_code: dbEvent.event_country_code,
              p_event_link: dbEvent.event_link,
              p_event_logo: null,
              p_offer_slug: null,
              p_offer_close_date: null,
              p_event_start: dbEvent.event_start,
              p_event_end: dbEvent.event_end,
              p_event_region: dbEvent.event_region,
              p_event_location: dbEvent.event_location || cleanedEvent.eventLocation || null,
              p_event_topics_updated_at: null,
              p_event_type: dbEvent.event_type,
              p_venue_address: cleanedEvent.venueAddress || null,
              p_scraped_by: cleanedEvent.scraperName || job.scraper_name || 'worker_scraper',
              p_scraper_id: job.scraper_id,
              p_source_type: dbEvent.source_type,
              p_source_details: dbEvent.source_details,
              p_event_timezone: dbEvent.event_timezone || null,
              p_luma_event_id: dbEvent.luma_event_id,
              p_source_event_id: dbEvent.source_event_id,
              p_luma_page_data: dbEvent.luma_page_data,
              p_meetup_page_data: dbEvent.meetup_page_data,
              p_content_category: scraperData.content_category || null
            };
            const result = await getSupabase().rpc('events_create', createParams);
            error = result.error;
            newEventUuid = result.data;
          }

          if (error) {
            if (error.code === '23505' || error.message?.includes('Duplicate event link')) {
              skippedCount++;
              logger.log(`⏭️  Skipped duplicate: ${cleanedEvent.eventTitle} (link already exists)`);
              return { status: 'skipped' };
            }
            failedCount++;
            logger.log(`❌ Failed to ${isUpdate ? 'update' : 'insert'}: ${cleanedEvent.eventTitle} - ${error.message}`, 'error');
            return { status: 'failed', error: error.message };
          }

          processedCount++;
          logger.log(`✅ ${isUpdate ? 'Updated' : 'Saved'}: ${cleanedEvent.eventTitle}`);

          // Record content source for the unified inbox.
          {
            const recordedUuid = isUpdate ? existingEventUuid : newEventUuid;
            if (recordedUuid) {
              const { error: srcErr } = await getSupabase().rpc('record_content_source', {
                p_content_type: 'event',
                p_content_id: recordedUuid,
                p_source_kind: 'scraper',
                p_source_ref: scraperData.name ?? `scraper:${scraperData.id ?? 'unknown'}`,
                p_source_meta: { scraper_id: scraperData.id ?? null, job_id: jobId },
              });
              if (srcErr) {
                logger.log(`⚠️ record_content_source failed (non-fatal): ${srcErr.message}`, 'warn');
              }
            }
          }

          // Apply the scraper's default_publish_state to newly-created events
          // (with backwards-compat fallback to legacy triage_mode if the new
          // column hasn't been backfilled). Only on initial create — updates
          // preserve the existing state set by the keyword/triage pipeline.
          if (!isUpdate && newEventUuid) {
            const initialState = scraperData.default_publish_state
              ?? (scraperData.triage_mode && scraperData.triage_mode !== 'auto_publish'
                  ? 'pending_review'
                  : 'published');
            if (initialState && initialState !== 'published') {
              const { error: stateErr } = await getSupabase().rpc('events_publish_state_set', {
                p_id:     newEventUuid,
                p_to:     initialState,
                p_actor:  `system:scraper:${scraperData.id ?? 'unknown'}`,
                p_reason: `default_publish_state=${initialState}`,
              });
              if (stateErr) {
                logger.log(`⚠️ Failed to set publish_state=${initialState} on event ${newEventUuid}: ${stateErr.message} (non-fatal; event remains in default state)`, 'warn');
              } else {
                logger.log(`📋 Initial publish_state=${initialState} (gated by scraper config)`);
                // Enqueue a verdict-change event so the verdict handler will
                // submit to triage, regardless of whether content-keywords is
                // installed. The handler treats "no keyword verdict yet" as
                // is_visible=true and submits to triage if state=pending_review.
                if (initialState === 'pending_review') {
                  const { error: enqErr } = await getSupabase()
                    .from('content_publish_state_event_queue')
                    .insert({
                      content_type: 'event',
                      content_id: newEventUuid,
                      trigger: 'scraper_initial',
                      payload: { scraper_id: scraperData.id ?? null, job_id: jobId },
                    });
                  if (enqErr) {
                    logger.log(`⚠️ Failed to enqueue verdict-change for event ${newEventUuid}: ${enqErr.message}`, 'warn');
                  }
                }
              }
            }
          }

          if (screenshotUrl && screenshotGeneratedAt) {
            await getSupabase().rpc('events_update_screenshot_status', {
              p_event_id: eventId,
              p_screenshot_generated: true,
              p_screenshot_url: screenshotUrl,
              p_screenshot_generated_at: screenshotGeneratedAt,
            });
          }

          // Update luma_guest_count / luma_ticket_count from the freshly-scraped
          // __NEXT_DATA__ so the Registrations tab and host leaderboard reflect
          // the live state of the event on Luma. Non-blocking — a failure here
          // doesn't invalidate the event save above.
          let lumaGuestCount = null;
          let lumaTicketCount = null;
          try {
            const linkedEventUuid = isUpdate ? existingEventUuid : newEventUuid;
            if (cleanedEvent.lumaPageData && linkedEventUuid) {
              const counts = extractLumaCountsFromLumaData(cleanedEvent.lumaPageData);
              lumaGuestCount = counts.guest_count;
              lumaTicketCount = counts.ticket_count;
              if (lumaGuestCount !== null || lumaTicketCount !== null) {
                await getSupabase()
                  .from('events')
                  .update({
                    luma_guest_count: lumaGuestCount,
                    luma_ticket_count: lumaTicketCount,
                    luma_counts_updated_at: new Date().toISOString(),
                  })
                  .eq('id', linkedEventUuid);
                logger.log(`👥 Luma counts: ${lumaGuestCount ?? '—'} guests, ${lumaTicketCount ?? '—'} tickets`);
              }
            }
          } catch (countErr) {
            logger.log(`⚠️ Failed to update Luma counts (non-fatal): ${countErr.message}`, 'warn');
          }

          // Link the event to its calendar(s). Sources, in order:
          //   1. cleanedEvent.calendarUuid — direct UUID override (legacy;
          //      kept for any scraper that still pre-resolves a calendar).
          //   2. cleanedEvent.calendarScraperId — auto-discovery scrapers
          //      (LumaSearch / LumaCategory) drop the *child* scraper id
          //      onto the event so we know which scraper's calendar this
          //      event belongs to, even though the running job is the
          //      parent. Resolved (and lazily created) below.
          //   3. job.scraper_id — the iCal case where the running scraper
          //      IS the calendar's scraper.
          //
          // For (2) and (3) we look up an existing calendar; if none
          // exists we lazily create one. This is the single calendar-
          // creation site for scrapers — eager creation in
          // POST /api/scrapers and the search/category scrapers used to
          // leave empty calendar shells whenever a scraper never produced
          // events; this design avoids that.
          //
          // Upsert so repeated runs don't duplicate rows (pk is
          // calendar_id+event_id).
          try {
            const linkedEventUuid = isUpdate ? existingEventUuid : newEventUuid;
            if (linkedEventUuid) {
              const calendarIds = new Set();
              if (cleanedEvent.calendarUuid) calendarIds.add(cleanedEvent.calendarUuid);

              const candidateScraperIds = new Set();
              if (cleanedEvent.calendarScraperId) candidateScraperIds.add(cleanedEvent.calendarScraperId);
              if (job.scraper_id) candidateScraperIds.add(job.scraper_id);
              for (const sid of candidateScraperIds) {
                const cid = await findOrCreateCalendarForScraper(sid);
                if (cid) calendarIds.add(cid);
              }

              if (calendarIds.size > 0) {
                const rows = Array.from(calendarIds).map((cid) => ({
                  calendar_id: cid, event_id: linkedEventUuid, added_via: 'scraper',
                }));
                const { error: linkErr } = await getSupabase()
                  .from('calendars_events')
                  .upsert(rows, { onConflict: 'calendar_id,event_id', ignoreDuplicates: true });
                if (linkErr) {
                  logger.log(`⚠️ Failed to link event to calendar(s): ${linkErr.message}`, 'warn');
                } else {
                  logger.log(`📆 Linked to ${calendarIds.size} calendar(s)`);
                }
              }
            }
          } catch (linkErr) {
            logger.log(`⚠️ Calendar linking failed (non-fatal): ${linkErr.message}`, 'warn');
          }

          // Triage submission is no longer inline. Initial publish_state
          // (above) lands the event in `pending_review` if the scraper is
          // configured to gate. The keyword-verdict handler then enqueues
          // a triage row when the keyword evaluation completes.
          // See spec-content-publishing-pipeline.md §4.5.1.

          // Extract and persist event hosts + speakers (non-blocking).
          try {
            const gatewazeEventUuid = isUpdate ? existingEventUuid : newEventUuid;
            const eventContext = {
              sourceEventId: dbEvent.luma_event_id || dbEvent.source_event_id || dbEvent.event_id,
              gatewazeEventId: gatewazeEventUuid,
              eventTitle: dbEvent.event_title,
              eventUrl: dbEvent.event_link,
              eventStartAt: dbEvent.event_start,
              calendarName: cleanedEvent.account || null,
              guestCount: lumaGuestCount, // denormalised onto event_host_events for leaderboard
            };

            if (cleanedEvent.lumaPageData) {
              const hosts = extractHostsFromLumaData(cleanedEvent.lumaPageData);
              if (hosts.length > 0) {
                const { inserted, linked } = await upsertHosts(getSupabase(), hosts, eventContext);
                if (inserted > 0 || linked > 0) {
                  logger.log(`👤 Hosts: ${inserted} new, ${linked} linked to event`);
                }
              }
            }

            // Convert Luma's description_mirror (ProseMirror JSON) → HTML
            // and migrate lumacdn images to Supabase storage. Result lands
            // in events.luma_processed_html — what the portal renders. This
            // is the rich content path the legacy gatewaze-admin workers
            // built; ported here so the same pipeline runs inline.
            let processedHtml = null;
            if (cleanedEvent.lumaPageData && gatewazeEventUuid) {
              try {
                const result = await processLumaContentInline({
                  supabase: getSupabase(),
                  eventUuid: gatewazeEventUuid,
                  lumaPageData: cleanedEvent.lumaPageData,
                  logger: (msg) => logger.log(msg),
                });
                if (result.success && !result.skipped && result.html) {
                  processedHtml = result.html;
                } else if (result.success && result.html) {
                  // Unchanged but already-completed — reuse for speaker extraction.
                  processedHtml = result.html;
                } else if (!result.success) {
                  logger.log(`⚠️ Luma content processing failed (non-fatal): ${result.error}`, 'warn');
                }
              } catch (procErr) {
                logger.log(`⚠️ Luma content processing threw (non-fatal): ${procErr.message}`, 'warn');
              }
            }

            // Speaker extraction is now deferred to the bulk
            // scraper:speaker-extract job, enqueued once per run after
            // the scrape finishes. Saves ~1-6 s per event of synchronous
            // Anthropic latency from the user-facing scrape job.
            // The handler reads events.luma_processed_html (just written
            // above) and events.event_description as input.
            if (gatewazeEventUuid && (processedHtml || cleanedEvent.description || cleanedEvent.pageContent)) {
              speakerExtractEventUuids.push(gatewazeEventUuid);
            }
          } catch (extractErr) {
            logger.log(`⚠️ Host/speaker extraction failed (non-fatal): ${extractErr.message}`, 'warn');
          }

          if (dbEvent.luma_page_data || dbEvent.meetup_page_data) {
            const dataTypes = [];
            if (dbEvent.luma_page_data) dataTypes.push('Luma');
            if (dbEvent.meetup_page_data) dataTypes.push('Meetup');
            logger.log(`📄 Saved ${dataTypes.join(' & ')} page data for ${cleanedEvent.eventTitle}`);
          }
          // NOTE: the legacy LUMA_CONTENT_PROCESS enqueue was removed here —
          // it called a Supabase RPC (events_create_placeholder_speaker_with_talk)
          // that doesn't exist in the current schema, and the luma-extractor
          // path above already handles hosts + speakers directly.

          return { status: 'processed' };
        } catch (dbError) {
          failedCount++;
          logger.log(`❌ Database error for ${cleanedEvent.eventTitle}: ${dbError.message}`, 'error');
          return { status: 'failed', error: dbError.message };
        }
      } catch (error) {
        failedCount++;
        logger.log(`❌ Failed to process event: ${error.message}`, 'error');
        return { status: 'failed', error: error.message };
      }
    };

    // Expose the save pipeline to scrapers that want to stream saves. A scraper
    // that opts in should call `await this.globalConfig.saveEvent(event)` as
    // each event is parsed AND filtered, and SHOULD NOT include that event in
    // the array it returns from scrape() (to avoid double-saving). Scrapers
    // that don't opt in keep returning their full array and the batch loop
    // below handles persistence.
    globalConfig.saveEvent = processAndSaveEvent;

    // Run scraper with console.log tee'd to the logger so every scraper's
    // progress output (e.g. "🔎 Searching", "📅 New calendar discovered")
    // is streamed to the SSE log feed and persisted to scrapers_job_logs.
    // Scrapers that opt into the logger via this.logger.log get richer level
    // tagging; everything else still shows up via the console tee.
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    // Guard against recursion: logger.log internally calls console.log to write
    // to Docker logs (`[Scraper N] ...`), which would otherwise bounce back into
    // the tee and loop forever. This flag suppresses tee behaviour while inside
    // a logger call.
    let insideTee = false;

    const teeLevel = (level) => (...args) => {
      if (insideTee) {
        if (level === 'error') return originalError(...args);
        if (level === 'warn') return originalWarn(...args);
        return originalLog(...args);
      }
      const message = args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
      insideTee = true;
      try {
        try { logger.log(message, level); } catch { /* logger crash shouldn't break scraping */ }
      } finally {
        insideTee = false;
      }
      // Also pass through to the real stream so Docker logs + prod logs keep working
      if (level === 'error') originalError(...args);
      else if (level === 'warn') originalWarn(...args);
      else originalLog(...args);
    };

    console.log = teeLevel('info');
    console.warn = teeLevel('warn');
    console.error = teeLevel('error');

    logger.log(`🚀 Starting scrape operation...`);
    let events;
    try {
      events = await scraper.scrape();
    } finally {
      // Always restore console, even if the scraper throws
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }

    logger.log(`✅ Scraping completed! Found ${events?.length || 0} events`);
    logger.progress(scraper.stats);

    // Process and save any events returned by the scraper. Streaming-capable
    // scrapers will have already persisted their events via globalConfig.saveEvent
    // and should return an empty (or much shorter) array here. Non-streaming
    // scrapers flow entirely through this loop.
    if ((events?.length || 0) > 0) {
      logger.log(`🔄 Processing ${events.length} returned events (cleaning, country/region mapping, topic matching, geocoding)...`);
      for (const event of events) {
        await processAndSaveEvent(event);
      }
    }


    logger.log(`📊 Final stats: ${processedCount} processed, ${skippedCount} skipped, ${failedCount} failed, ${filteredCount} filtered`);

    // Update job as completed
    await updateJobStatus(jobId, 'completed', {
      found: events?.length || 0,
      total: events?.length || 0,
      processed: processedCount,
      skipped: skippedCount,
      failed: failedCount
    });

    const result = {
      processed: processedCount,
      skipped: skippedCount,
      failed: failedCount,
      filtered: filteredCount,
      total: events?.length || 0
    };

    // Enqueue the bulk speaker-extract job for every event we just
    // saved that has descriptive content. Fire-and-forget — a queue
    // failure shouldn't fail the user-facing scrape job.
    if (speakerExtractEventUuids.length > 0 && _addJob && _JobTypes) {
      try {
        await _addJob(_JobTypes.SCRAPER_SPEAKER_EXTRACT, {
          event_uuids: speakerExtractEventUuids,
          scraper_id: scraperData?.id ?? null,
          brand_id: process.env.BRAND || 'default',
        });
        logger.log(
          `🎤 Enqueued speaker extraction for ${speakerExtractEventUuids.length} event(s) ` +
          `(processes async; speakers populate within ~1-5 min)`,
        );
      } catch (enqErr) {
        logger.log(
          `⚠️ Failed to enqueue speaker-extract bulk job (non-fatal): ${enqErr.message}`,
          'warn',
        );
      }
    }

    logger.complete(true, result);

    // Cleanup
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    cleanupJobDirectory(jobTempDir);

    logger.log(`✅ Scraper job completed successfully`);

    return result;

  } catch (error) {
    logger.log(`❌ Scraper job failed: ${error.message}`, 'error');
    logger.error(error);

    // Clean up browser to prevent orphaned Chromium processes
    if (scraper) {
      try {
        await scraper.cleanup();
      } catch (cleanupError) {
        logger.log(`⚠️ Browser cleanup failed: ${cleanupError.message}`, 'warn');
      }
    }

    // Update job as failed
    await updateJobStatus(jobId, 'failed', {
      error: error.message
    });

    logger.complete(false, {
      error: error.message
    });

    // Cleanup on error
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (jobTempDir) {
      cleanupJobDirectory(jobTempDir);
    }

    throw error;
  }
}
