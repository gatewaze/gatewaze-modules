/**
 * Populate `calendars.cover_image_url` from the Luma calendar page banner.
 *
 * Luma's calendar page (`https://lu.ma/{slug}`) embeds a __NEXT_DATA__ JSON
 * blob whose `data.calendar.cover_image_url` is the hero/banner image. We
 * download that, upload to the `media` bucket at the same path the admin
 * upload field uses (`calendars/{calendar_id}-cover.{ext}`), and persist the
 * relative path on the calendar row. Portal resolution to a public URL is
 * handled at render time via `toPublicUrl(...)`.
 *
 * Idempotent on three levels:
 *   - Per-process cache: each calendar UUID is attempted at most once per
 *     worker run, so a 100-event scrape doesn't hammer lu.ma.
 *   - Skip if `cover_image_url` is already set: never clobbers an admin
 *     upload or a previously-seeded value.
 *   - Storage upsert at the same path: a future cover refresh (when we add
 *     one) replaces the blob in place rather than leaking orphans.
 *
 * Fire-and-forget at call sites — a slow fetch or 5xx from Luma must not
 * block event ingestion.
 */

const _processedCache = new Set();

async function fetchLumaCalendarBanner(slug) {
  const url = `https://lu.ma/${slug}`;
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; GatewazeScraper/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) return null;
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[1]); } catch { return null; }
  const calendar = data?.props?.pageProps?.initialData?.data?.calendar;
  return calendar?.cover_image_url || null;
}

export async function populateLumaCalendarCoverIfMissing(supabase, calendarUuid, opts = {}) {
  if (!supabase || !calendarUuid) return { skipped: true, reason: 'missing-args' };
  if (_processedCache.has(calendarUuid)) return { skipped: true, reason: 'already-attempted-this-process' };
  _processedCache.add(calendarUuid);

  const { data: cal, error } = await supabase
    .from('calendars')
    .select('id, calendar_id, slug, cover_image_url, luma_calendar_id')
    .eq('id', calendarUuid)
    .maybeSingle();
  if (error || !cal) return { skipped: true, reason: 'calendar-not-found' };
  if (cal.cover_image_url) return { skipped: true, reason: 'cover-already-set' };
  if (!cal.luma_calendar_id) return { skipped: true, reason: 'not-a-luma-calendar' };

  const slug = opts.slug || cal.slug;
  if (!slug) return { skipped: true, reason: 'no-slug' };

  let lumaImageUrl;
  try {
    lumaImageUrl = await fetchLumaCalendarBanner(slug);
  } catch (e) {
    return { skipped: true, reason: `luma-page-fetch-failed: ${e.message}` };
  }
  if (!lumaImageUrl) return { skipped: true, reason: 'no-banner-on-luma-page' };

  const fetch = (await import('node-fetch')).default;
  let imgRes;
  try {
    imgRes = await fetch(lumaImageUrl);
  } catch (e) {
    return { skipped: true, reason: `image-fetch-failed: ${e.message}` };
  }
  if (!imgRes.ok) return { skipped: true, reason: `image-fetch-${imgRes.status}` };

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const contentType = imgRes.headers.get('content-type') || '';
  let ext = 'jpg';
  if (contentType.includes('png')) ext = 'png';
  else if (contentType.includes('webp')) ext = 'webp';
  else if (contentType.includes('gif')) ext = 'gif';

  const filePath = `calendars/${cal.calendar_id}-cover.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('media')
    .upload(filePath, buffer, {
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

export default { populateLumaCalendarCoverIfMissing };
