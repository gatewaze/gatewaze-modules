/**
 * Pure helpers for GatewazePortalEventsScraper: validate the source, and map
 * one event from another Gatewaze brand's public portal API onto the shape
 * scraper-job-handler's save pipeline expects.
 *
 * The source is the public, unauthenticated `/api/portal/events` API that
 * every Gatewaze brand serves (e.g. https://api.aaif.live). Its listing
 * already applies that brand's own publishing rules (live, listed, has a card
 * image), so whatever it lists is what the brand shows the public.
 *
 * Kept free of I/O so it can be unit tested without a worker.
 */

// Default mapping from source event types to this brand's types. Each brand
// configures its own list under Settings → Event types; an unmapped type is
// passed through unchanged. Overridable per scraper via config.event_type_map.
export const DEFAULT_EVENT_TYPE_MAP = Object.freeze({
  'community-event': 'meetup',
  virtual: 'webinar',
  forum: 'conference',
});

/**
 * Build the event type map from the scraper config. The admin editor stores
 * list fields as string arrays, so mappings are written "source=target", e.g.
 * ["community-event=meetup", "virtual=webinar"]. An object is accepted too.
 * Config entries override the defaults.
 */
export function parseEventTypeMap(value) {
  const out = { ...DEFAULT_EVENT_TYPE_MAP };
  const put = (from, to) => {
    const f = typeof from === 'string' ? from.trim() : '';
    const t = typeof to === 'string' ? to.trim() : '';
    if (f && t && f.length <= 64 && t.length <= 64) out[f] = t;
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const i = entry.indexOf('=');
      if (i > 0) put(entry.slice(0, i), entry.slice(i + 1));
    }
  } else if (value && typeof value === 'object') {
    for (const [from, to] of Object.entries(value)) put(from, to);
  }
  return out;
}

const MAX_PAGE_CONTENT = 40_000;
const MAX_DESCRIPTION = 20_000;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Hostnames that resolve inside the cluster or the host. The worker fetches
// these URLs itself (and the save pipeline fetches the card image), so a
// source that pointed at one would turn the scraper into an internal proxy.
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.svc', '.cluster.local', '.lan', '.home.arpa'];

function isIpLiteral(hostname) {
  if (hostname.startsWith('[') || hostname.includes(':')) return true; // IPv6
  if (/^\d+$/.test(hostname)) return true; // decimal-encoded IPv4
  if (/^0x[0-9a-f]+$/i.test(hostname)) return true; // hex-encoded IPv4
  return /^[\d.]+$/.test(hostname) || /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){1,3}$/i.test(hostname);
}

/**
 * True when `value` is an absolute https URL on a public DNS name, with no
 * credentials and no non-default port.
 */
export function isPublicHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  if (!host || !host.includes('.')) return false;
  if (host === 'localhost' || isIpLiteral(host)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return false;
  return true;
}

/**
 * True for http(s) URLs a visitor can follow. Event links are only stored and
 * shown, never fetched by the scraper, so plain http is allowed.
 */
function isWebUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Resolve the API origin, the public portal origin and the source key from
 * the scraper's base_url and config. Throws on anything that is not a public
 * https origin.
 *
 *   base_url            https://api.aaif.live   (the brand's API)
 *   config.portal_url   https://aaif.live       (optional; default strips "api.")
 */
export function resolveSource(baseUrl, portalUrl) {
  if (!isPublicHttpsUrl(baseUrl)) {
    throw new Error('GatewazePortalEventsScraper: base_url must be a public https URL, e.g. https://api.aaif.live');
  }
  const api = new URL(baseUrl);
  let portalOrigin;
  if (portalUrl !== undefined && portalUrl !== null && portalUrl !== '') {
    if (!isPublicHttpsUrl(portalUrl)) {
      throw new Error('GatewazePortalEventsScraper: config.portal_url must be a public https URL');
    }
    portalOrigin = new URL(portalUrl).origin;
  } else {
    const host = api.hostname.replace(/^api\./i, '');
    portalOrigin = `https://${host}`;
  }
  return {
    apiOrigin: api.origin,
    portalOrigin,
    // Namespaces source_event_id so ids from two source brands never collide.
    sourceKey: new URL(portalOrigin).hostname.toLowerCase(),
  };
}

export function isValidEventId(value) {
  return typeof value === 'string' && EVENT_ID_RE.test(value);
}

function decodeHtmlEntities(input) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
  const toChar = (code, orig) => {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return orig;
    try { return String.fromCodePoint(code); } catch { return orig; }
  };
  return String(input == null ? '' : input)
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, h) => toChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => toChar(parseInt(d, 10), m))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) => named[n] ?? named[n.toLowerCase()] ?? m);
}

/**
 * Light cleanup of source HTML before it is stored as events.page_content.
 * The portal sanitises again with DOMPurify on render; this removes the parts
 * no surface should ever receive (scripts, styles, inline handlers, and
 * javascript:/data: links) and caps the length.
 */
export function cleanEventHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  let out = html
    .replace(/<(script|style|iframe|object|embed|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|noscript|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s(href|src)\s*=\s*(["'])\s*(javascript|data|vbscript):[^"']*\2/gi, '')
    .replace(/\s(href|src)\s*=\s*(javascript|data|vbscript):[^\s>]*/gi, '')
    .trim();
  if (out.length > MAX_PAGE_CONTENT) out = out.slice(0, MAX_PAGE_CONTENT);
  return out;
}

export function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  return decodeHtmlEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

/** Parse "lat,lng" into numbers, or null when it is not a valid coordinate. */
export function parseLatLng(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map((s) => s.trim());
  if (parts.length !== 2 || parts.some((p) => p === '')) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Map one source event onto the save pipeline's event shape.
 *
 * `detail` is the `/api/portal/events/:id` payload; `listing` is the listing
 * row (used as a fallback for fields the detail lacks). Returns
 * `{ event }` or `{ skip: '<reason>' }`.
 */
export function mapPortalEvent(detail, listing, opts) {
  const src = { ...(listing || {}), ...(detail || {}) };
  const { portalOrigin, sourceKey, scraperName } = opts;
  const typeMap = opts.eventTypeMap || DEFAULT_EVENT_TYPE_MAP;

  const eventId = src.event_id;
  if (!isValidEventId(eventId)) return { skip: 'invalid event_id' };

  const title = str(src.event_title);
  if (!title) return { skip: 'no title' };

  const start = str(src.event_start);
  if (!start || Number.isNaN(Date.parse(start))) return { skip: 'no start date' };
  const end = str(src.event_end);

  // The source portal only lists events with a card image, and this brand's
  // portal applies the same rule, so an event without one is not worth saving.
  const cover = str(src.screenshot_url) || str(src.event_logo);
  if (!isPublicHttpsUrl(cover)) return { skip: 'no usable card image' };

  // Send visitors to where they can register. For an event the source brand
  // runs itself (native registration, or no outside link) that is the source
  // portal's own event page.
  const sourcePage = `${portalOrigin}/events/${encodeURIComponent(eventId)}`;
  const outsideLink = str(src.event_link);
  const eventLink = !src.enable_native_registration && isWebUrl(outsideLink)
    ? outsideLink
    : sourcePage;

  const rawType = str(src.event_type);
  const eventType = rawType && Object.hasOwn(typeMap, rawType) ? typeMap[rawType] : (rawType || 'conference');

  const city = str(src.event_city);
  const isVirtual = rawType === 'virtual' || city.toLowerCase() === 'online';

  const bodyHtml = cleanEventHtml(
    str(src.page_content) || str(src.luma_processed_html) || str(src.meetup_processed_html),
  );
  let description = htmlToText(str(src.event_description)) || htmlToText(bodyHtml);
  if (description.length > MAX_DESCRIPTION) description = description.slice(0, MAX_DESCRIPTION);

  const coordinates = parseLatLng(str(src.event_location));
  const lumaEventId = /^evt-[A-Za-z0-9]{6,40}$/.test(str(src.luma_event_id)) ? str(src.luma_event_id) : null;
  const countryCode = str(src.event_country_code);
  const topics = Array.isArray(src.event_topics)
    ? src.event_topics.filter((t) => typeof t === 'string' && t.trim()).slice(0, 50)
    : [];

  return {
    event: {
      eventTitle: title,
      eventLink,
      eventStart: start,
      eventEnd: end && !Number.isNaN(Date.parse(end)) ? end : null,
      eventCity: city,
      eventCountryCode: countryCode.length === 2 ? countryCode.toUpperCase() : '',
      eventRegion: str(src.event_region),
      eventLocation: coordinates ? `${coordinates.lat},${coordinates.lng}` : '',
      ...(coordinates ? { coordinates } : {}),
      venueAddress: str(src.venue_address) || null,
      eventTimezone: str(src.event_timezone) || 'UTC',
      eventType,
      eventTopics: topics,
      listingIntro: '',
      eventDescription: description,
      description,
      pageContentHtml: bodyHtml.length > 20 ? bodyHtml : null,
      coverImageUrl: cover,
      isVirtual,
      lumaEventId,
      scraperName,
      sourceEventId: `portal:${sourceKey}:${eventId}`,
      sourceDetails: {
        source_portal: portalOrigin,
        source_event_id: eventId,
        source_event_url: sourcePage,
        source_event_type: rawType || null,
        source_event_link: outsideLink || null,
      },
    },
  };
}
