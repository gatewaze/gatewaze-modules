/**
 * Pure helper for the *Fast scraper variants: translate the
 * scrapling-fetcher service's response shape into the same object shape
 * the slow scrapers' Puppeteer-based `fetchEventPageData` returns.
 *
 * Extracted so it can be unit-tested without importing the slow parent
 * classes (which top-level-import puppeteer + node-ical and so can't
 * load in a test process that doesn't have those installed).
 *
 * The contract is: downstream code (parseICalEvent, host extraction,
 * scraper-job-handler save loop) must be unable to tell whether the
 * data came through the fast or slow path.
 */

/**
 * @param {object} serviceResult — the response from `fetchPage(...)`.
 * @param {object} [opts]
 * @param {boolean} [opts.includeCalendarData=false] — Search/Category
 *   variants need `calendarData`; iCal does not (calendar is resolved
 *   via the iCal feed URL, not the event page).
 * @returns {object} — { coverImageUrl, pageContent, isVirtual, lumaData,
 *   lumaPageData, [calendarData] }
 */
export function normalizeServiceResponse(serviceResult, opts = {}) {
  const next = serviceResult?.nextData ?? null;
  // The scrapling-fetcher service returns next_data already unwrapped to
  // `{ buildId, pageProps }`, whereas Puppeteer-scraped __NEXT_DATA__ is
  // `{ props: { pageProps }, … }`. Resolve pageProps under either shape — a
  // mismatch here silently nulls `event`, so the cover image (and every other
  // page-derived field) is lost and the portal falls back to the OG image.
  const pageProps = next?.props?.pageProps ?? next?.pageProps ?? null;
  const data = pageProps?.initialData?.data || pageProps?.data || null;
  const event = data?.event ?? null;

  const lumaData = event
    ? {
        lumaEventId: event.api_id,
        name: event.name,
        startAt: event.start_at,
        endAt: event.end_at,
        timezone: event.timezone,
        coverUrl: event.cover_url,
        latitude: event.coordinate?.latitude || event.geo_latitude,
        longitude: event.coordinate?.longitude || event.geo_longitude,
        city: event.geo_address_info?.city,
        country: event.geo_address_info?.country,
        countryCode: event.geo_address_info?.country_code,
        region: event.geo_address_info?.region,
        venueAddress: event.geo_address_info?.address,
        fullAddress: event.geo_address_info?.full_address,
        locationType: event.location_type,
        description: event.description_mirror || event.description || '',
      }
    : null;

  // Strip user-specific data from the persisted lumaPageData blob,
  // mirroring what the parent fetchEventPageData does after page.evaluate
  // returns.
  const lumaPageData = next ? structuredClone(next) : null;
  if (lumaPageData) {
    try {
      // Same dual-shape resolution as above so the guest/user PII strip
      // actually targets the persisted blob (it was a no-op on the
      // scrapling-fetcher shape).
      const clonedData = (lumaPageData.props?.pageProps ?? lumaPageData.pageProps)
        ?.initialData?.data;
      if (clonedData) {
        delete clonedData.guests;
        delete clonedData.user;
      }
    } catch {
      /* ignore */
    }
  }

  const result = {
    coverImageUrl: event?.cover_url || null,
    pageContent: '',
    isVirtual: event?.location_type === 'online',
    lumaData,
    lumaPageData,
  };

  if (opts.includeCalendarData) {
    const calData = data?.calendar;
    result.calendarData = calData?.api_id
      ? {
          apiId: calData.api_id,
          name: calData.name || '',
          slug: calData.slug || '',
          url: calData.slug ? `https://lu.ma/${calData.slug}` : null,
        }
      : null;
  }

  return result;
}
