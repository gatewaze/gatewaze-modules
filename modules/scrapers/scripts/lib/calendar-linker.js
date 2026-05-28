/**
 * Shared helper: create a `calendars` row linked to a Luma iCal scraper.
 *
 * Called from two places:
 *   1. LumaSearchScraper — when a new calendar is auto-discovered during a search run.
 *   2. The POST /api/scrapers endpoint — when an admin manually creates a LumaICalScraper.
 *
 * Idempotent: if a calendar with the same luma_calendar_id already exists,
 * just links the scraper ID back onto it (if the calendar doesn't already
 * have one). Slug collisions with existing Gatewaze calendars fall back to
 * a "luma-" prefix.
 */

/**
 * Best-effort extraction of the Luma calendar api_id from either a
 * LumaICalScraper config (where it may be set explicitly as ical_id) or by
 * visiting the calendar URL and extracting __NEXT_DATA__.calendar.api_id.
 *
 * @returns {Promise<{apiId: string, name: string, slug: string, url: string}|null>}
 */
async function resolveLumaCalendarFromScraper(scraperRow) {
  // Fast path: admin filled in config.ical_id
  const apiId = scraperRow?.config?.ical_id;
  const baseUrl = scraperRow?.base_url || '';
  // Accept both `lu.ma/...` and `luma.com/...` — older community
  // scrapers were configured against luma.com when that was the canonical
  // domain, and the slug is identical to the lu.ma form.
  const slugFromUrl = baseUrl.match(/(?:lu\.ma|luma\.com)\/([^/?]+)/i)?.[1];

  if (apiId && slugFromUrl) {
    return {
      apiId,
      name: scraperRow?.config?.account || scraperRow?.name || slugFromUrl,
      slug: slugFromUrl,
      url: `https://lu.ma/${slugFromUrl}`,
    };
  }

  // We need the api_id to dedupe properly. Without it we can still create
  // a calendar keyed on slug, but dedup across rescrapes is weaker.
  if (!slugFromUrl) return null;
  return {
    apiId: apiId || null,
    name: scraperRow?.config?.account || scraperRow?.name || slugFromUrl,
    slug: slugFromUrl,
    url: `https://lu.ma/${slugFromUrl}`,
  };
}

function makeCalendarIdCode(apiId, slug) {
  // Prefer the full slug — it's the natural human-readable identifier
  // (Luma URLs are lu.ma/<slug>) and is unique by definition. Fall back
  // to the full apiId, then leave it null so the DB's
  // generate_calendar_id trigger fills in a random UUID-derived code.
  //
  // Earlier versions of this function truncated to the last 8 alphanumeric
  // chars to keep IDs short, but a network of community calendars
  // (london-events, berlin-events, portland-events, …) collided constantly
  // on those 8 chars. Full slug is unique on Luma's side, so it carries
  // no collision risk at our source-of-truth.
  const source = (slug || apiId || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (!source) return null;
  return `CAL-${source}`;
}

/**
 * Ensure a calendar row exists for the given scraper + calendar info.
 * Returns { action: 'created'|'linked'|'existed', calendarId?, error? }.
 */
export async function ensureCalendarForScraper(supabase, scraperRow, calendarInfo, opts = {}) {
  if (!supabase || !scraperRow?.id || !calendarInfo) {
    return { action: 'skipped', error: 'missing supabase/scraper/calendar info' };
  }

  const { apiId, name, slug, url } = calendarInfo;

  // 1. Existing calendar by luma_calendar_id?
  if (apiId) {
    const { data: existing } = await supabase
      .from('calendars')
      .select('id, default_scraper_id')
      .eq('luma_calendar_id', apiId)
      .maybeSingle();

    if (existing) {
      if (!existing.default_scraper_id) {
        await supabase
          .from('calendars')
          .update({ default_scraper_id: scraperRow.id })
          .eq('id', existing.id);
        return { action: 'linked', calendarId: existing.id };
      }
      return { action: 'existed', calendarId: existing.id };
    }
  }

  // 2. Slug-collision fallback: if the raw slug is already used, prefix with "luma-"
  let finalSlug = slug;
  const { data: slugTaken } = await supabase
    .from('calendars')
    .select('id')
    .eq('slug', finalSlug)
    .maybeSingle();
  if (slugTaken) {
    finalSlug = `luma-${slug}`;
    const { data: prefixedTaken } = await supabase
      .from('calendars')
      .select('id')
      .eq('slug', finalSlug)
      .maybeSingle();
    if (prefixedTaken) {
      finalSlug = `luma-${(apiId || slug).toLowerCase()}`;
    }
  }

  const calendarIdCode = makeCalendarIdCode(apiId, slug);
  // Drop calendar_id from the payload when null so the DB's
  // generate_calendar_id trigger picks a random fallback instead of
  // tripping the NOT-NULL check.
  const insertRow = {
    name,
    slug: finalSlug,
    external_url: url,
    luma_calendar_id: apiId || null,
    default_scraper_id: scraperRow.id,
    is_public: true,
    is_active: true,
    visibility: 'public',
    metadata: {
      source: opts.source || 'luma-scraper',
      ...(opts.metadata || {}),
    },
  };
  if (calendarIdCode) insertRow.calendar_id = calendarIdCode;

  const { data: created, error } = await supabase
    .from('calendars')
    .insert(insertRow)
    .select('id')
    .single();

  if (error) {
    return { action: 'failed', error: error.message };
  }
  return { action: 'created', calendarId: created?.id, calendarIdCode, finalSlug };
}

export { resolveLumaCalendarFromScraper, makeCalendarIdCode };

export default { ensureCalendarForScraper, resolveLumaCalendarFromScraper, makeCalendarIdCode };
