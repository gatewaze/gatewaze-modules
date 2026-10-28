/**
 * Fill in a calendar's cover image and location from its Luma calendar page.
 *
 * Luma's calendar page (`https://lu.ma/{slug}`) embeds a __NEXT_DATA__ JSON
 * blob whose `data.calendar` carries both the hero/banner image
 * (`cover_image_url`) and the calendar's own place (`location` with city,
 * region, country and country_code, plus `coordinate`). One page fetch serves
 * both.
 *
 * Cover: downloaded through the SSRF guard, uploaded to the `media` bucket at
 * the same path the admin upload field uses (`calendars/{calendar_id}-cover.{ext}`),
 * and the relative path saved on the row. Portal resolution to a public URL
 * is handled at render time via `toPublicUrl(...)`.
 *
 * Location: written to `settings.location` through the
 * calendars_apply_auto_location RPC, which validates the fields and never
 * overwrites a location an admin set by hand. When the Luma page has no
 * location, calendars_autofill_location_from_events falls back to the city
 * most of the calendar's events are in (calendars migration 017).
 *
 * Idempotent:
 *   - Per-process cache: each calendar UUID is attempted at most once every
 *     six hours, so a 100-event scrape doesn't hammer lu.ma.
 *   - Skips the page fetch when the cover is set and the location needs no
 *     filling: never clobbers an admin upload or an admin-set location.
 *   - Storage upsert at the same path: a future cover refresh replaces the
 *     blob in place rather than leaking orphans.
 *
 * Fire-and-forget at call sites — a slow fetch or 5xx from Luma must not
 * block event ingestion.
 */

import { fetchImage, guardedFetch } from './guarded-fetch.js';

// A brand-new calendar is first seen before its first event is linked, so
// the events fallback has nothing to work with yet. Attempts therefore expire
// rather than lasting the whole worker process.
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const _attemptedAt = new Map();

async function fetchLumaCalendarData(slug) {
  // Through the guard as well: lu.ma redirects (to luma.com), and every hop
  // is checked. Calendar pages are ~100-200 KB; the cap is generous.
  const res = await guardedFetch(`https://lu.ma/${encodeURIComponent(slug)}`, {
    maxBytes: 3 * 1024 * 1024,
    maxRedirects: 3,
    allowHttp: false,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; GatewazeScraper/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (res.status < 200 || res.status >= 300) return null;
  const html = res.buffer.toString('utf8');
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[1]); } catch { return null; }
  return data?.props?.pageProps?.initialData?.data?.calendar || null;
}

/**
 * Map a Luma calendar object to the CalendarLocation fields the
 * calendars_apply_auto_location RPC accepts, or null when Luma has no place
 * for the calendar. Pure, so it is unit-tested against captured page data.
 */
export function lumaCalendarLocation(calendar) {
  const loc = calendar?.location;
  if (!loc || typeof loc !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const out = {
    city: str(loc.city),
    state: str(loc.region),
    country: str(loc.country),
    country_code: str(loc.country_code)?.toUpperCase(),
  };
  if (!out.city && !out.country && !out.country_code) return null;
  const lat = calendar?.coordinate?.latitude;
  const lng = calendar?.coordinate?.longitude;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    out.latitude = lat;
    out.longitude = lng;
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/**
 * Does this settings.location still want an automatic value? Mirrors
 * calendars_location_is_auto_writable for the 'luma' source, so the worker
 * can skip the Luma page fetch when there is nothing to fill. The RPC makes
 * the final decision.
 */
export function locationNeedsAutofill(location) {
  if (!location || typeof location !== 'object') return true;
  if (location.source === 'events') return true;
  if (location.source) return false;
  const blank = (v) => !(typeof v === 'string' && v.trim());
  return (location.type ?? 'global') === 'global'
    && blank(location.city) && blank(location.state)
    && blank(location.country) && blank(location.country_code);
}

async function populateCover(supabase, cal, calendar) {
  const lumaImageUrl = calendar?.cover_image_url;
  if (!lumaImageUrl) return { skipped: true, reason: 'no-banner-on-luma-page' };

  let img;
  try {
    img = await fetchImage(lumaImageUrl);
  } catch (e) {
    return { skipped: true, reason: `image-fetch-failed: ${e.message}` };
  }
  if (!img) return { skipped: true, reason: 'image-fetch-not-an-image' };

  const contentType = img.contentType || '';
  let ext = 'jpg';
  if (contentType.includes('png')) ext = 'png';
  else if (contentType.includes('webp')) ext = 'webp';
  else if (contentType.includes('gif')) ext = 'gif';

  const filePath = `calendars/${cal.calendar_id}-cover.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('media')
    .upload(filePath, img.buffer, {
      upsert: true,
      contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      cacheControl: '3600',
    });
  if (uploadErr) return { skipped: true, reason: `storage-upload-failed: ${uploadErr.message}` };

  const { error: updateErr } = await supabase
    .from('calendars')
    .update({ cover_image_url: filePath })
    .eq('id', cal.id);
  if (updateErr) return { skipped: true, reason: `db-update-failed: ${updateErr.message}` };

  return { success: true, path: filePath };
}

async function populateLocation(supabase, cal, calendar) {
  const fromLuma = lumaCalendarLocation(calendar);
  if (fromLuma) {
    const { data, error } = await supabase.rpc('calendars_apply_auto_location', {
      p_calendar_id: cal.id,
      p_location: fromLuma,
      p_source: 'luma',
    });
    if (error) return { skipped: true, reason: `luma-location-rpc-failed: ${error.message}` };
    return { success: true, source: 'luma', changed: data === true };
  }
  const { data, error } = await supabase.rpc('calendars_autofill_location_from_events', {
    p_calendar_id: cal.id,
  });
  if (error) return { skipped: true, reason: `events-location-rpc-failed: ${error.message}` };
  return { success: true, source: 'events', changed: (data ?? 0) > 0 };
}

export async function populateLumaCalendarDetailsIfMissing(supabase, calendarUuid, opts = {}) {
  if (!supabase || !calendarUuid) return { skipped: true, reason: 'missing-args' };
  const lastAttempt = _attemptedAt.get(calendarUuid);
  if (lastAttempt && Date.now() - lastAttempt < RETRY_AFTER_MS) return { skipped: true, reason: 'attempted-recently' };
  _attemptedAt.set(calendarUuid, Date.now());

  const { data: cal, error } = await supabase
    .from('calendars')
    .select('id, calendar_id, slug, cover_image_url, luma_calendar_id, location:settings->location')
    .eq('id', calendarUuid)
    .maybeSingle();
  if (error || !cal) return { skipped: true, reason: 'calendar-not-found' };

  const needsCover = !cal.cover_image_url;
  const needsLocation = locationNeedsAutofill(cal.location);
  if (!needsCover && !needsLocation) return { skipped: true, reason: 'nothing-missing' };

  // Not a Luma calendar: the events are the only source we have.
  const slug = opts.slug || cal.slug;
  if (!cal.luma_calendar_id || !slug) {
    return { location: needsLocation ? await populateLocation(supabase, cal, null) : { skipped: true } };
  }

  let calendar = null;
  try {
    calendar = await fetchLumaCalendarData(slug);
  } catch {
    // Fall through: the location can still come from the events.
  }

  const result = {};
  if (needsCover) {
    result.cover = calendar ? await populateCover(supabase, cal, calendar) : { skipped: true, reason: 'luma-page-unavailable' };
  }
  if (needsLocation) result.location = await populateLocation(supabase, cal, calendar);
  return result;
}

export default { populateLumaCalendarDetailsIfMissing, lumaCalendarLocation, locationNeedsAutofill };
