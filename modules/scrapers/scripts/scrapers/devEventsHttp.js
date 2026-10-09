/**
 * Dependency-free HTTP + HTML helpers for the dev.events scrapers.
 *
 * dev.events is fully server-rendered: every listing row carries a JSON-LD
 * <script> with the event's name, dates, dev.events URL and address, and the
 * detail page links to the event's own site through an <iframe> preview or a
 * plain "Visit" anchor. None of it needs a browser, and headless Chromium on
 * the production worker could not load the site at all (renderer lost after
 * navigation, `networkidle2` never settling), so these scrapers fetch the HTML
 * directly and parse it with regular expressions.
 *
 * The worker image ships no HTML parser (no jsdom/cheerio), so everything here
 * is plain string work on well-known markup. Keep the regexes tolerant of
 * attribute order and line breaks; the site's markup is multi-line.
 *
 * Trust boundary: everything fetched here is third-party HTML. Fetches are
 * restricted to an explicit host allowlist per call (SSRF), bodies are capped,
 * and URLs lifted out of the HTML are normalised before they are followed or
 * stored.
 */

import { fetchPage } from '../lib/scrapling-fetcher.js';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Hosts the scrapers are allowed to fetch, by purpose. */
export const DEV_EVENTS_HOSTS = ['dev.events', 'www.dev.events'];
export const LUMA_HOSTS = ['lu.ma', 'luma.com', '*.lu.ma', '*.luma.com'];
export const MEETUP_HOSTS = ['meetup.com', '*.meetup.com'];

/** Largest listing page seen is ~150 KB; Luma pages ~200 KB. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostMatches(hostname, pattern) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".luma.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|\[.*\]|\d{1,3}(\.\d{1,3}){3})$/i;

/**
 * Parse and police a URL before it is fetched: https only, no IP literals or
 * internal names, and — when `allow` is given — a host from the allowlist.
 * Returns the URL object or null.
 */
export function policeUrl(url, { allow = null, schemes = ['https:'] } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!schemes.includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (!host || PRIVATE_HOST.test(host)) return null;
  if (allow && !allow.some((p) => hostMatches(host, p))) return null;
  return parsed;
}

/**
 * A URL lifted from third-party HTML that we will store (event link, cover
 * image) or HEAD-check: http(s) only, no private hosts. Returns the
 * normalised string or null.
 */
export function sanitizeExternalUrl(url) {
  const parsed = policeUrl(url, { schemes: ['https:', 'http:'] });
  // Return the string as written (not re-serialised): event links are the
  // dedupe key against rows the browser-era scrapers stored, and WHATWG
  // serialisation would add a trailing slash to bare origins.
  return parsed ? String(url).trim() : null;
}

/**
 * Fetch a page as text from an allowlisted host. Follows redirects but
 * re-checks the final host. Rejects non-HTML bodies and bodies over
 * MAX_RESPONSE_BYTES. Throws on policy failure, network failure or timeout;
 * returns { status, html, finalUrl } otherwise (including non-2xx so callers
 * can decide).
 *
 * `egress` is the scraper's residential-egress setting (see
 * resolveResidentialEgress in ../lib/scrapling-fetcher.js). When `egress.use`
 * is on, the request goes through the scrapling-fetcher service with
 * `proxy: "force"`, so it leaves from the service's residential provider and
 * carries Scrapling's browser-like TLS fingerprint. There is deliberately no
 * fallback to a direct fetch: a scraper that asked to look residential must
 * not quietly scrape from the cluster IP when the service is down.
 */
export async function fetchHtml(url, { allow, timeoutMs = 30000, headers = {}, maxBytes = MAX_RESPONSE_BYTES, egress = null } = {}) {
  if (!Array.isArray(allow) || allow.length === 0) {
    throw new Error('fetchHtml requires a host allowlist');
  }
  const target = policeUrl(url, { allow });
  if (!target) throw new Error(`Refusing to fetch URL outside the allowlist: ${url}`);

  if (egress?.use) {
    return fetchViaEgress(target.toString(), { timeoutMs, maxBytes, jobId: egress.jobId ?? null });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    });
    const finalUrl = response.url || target.toString();
    if (!policeUrl(finalUrl, { allow })) {
      throw new Error(`Redirected outside the allowlist: ${finalUrl}`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (response.ok && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error(`Unexpected content-type ${contentType || '(none)'} from ${finalUrl}`);
    }
    const declared = parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Response too large (${declared} bytes) from ${finalUrl}`);
    }
    const html = await readTextCapped(response, maxBytes, controller);
    return { status: response.status, html, finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The residential path: scrapling-fetcher `/fetch` in fast mode (plain HTTP
 * with a stealth fingerprint, no browser) with the proxy forced on. The
 * service applies its configured provider; credentials never reach the
 * worker. Throws ScraplingNotConfiguredError when SCRAPLING_FETCHER_URL is
 * unset and ScraplingTransportError on service failures.
 */
async function fetchViaEgress(url, { timeoutMs, maxBytes, jobId }) {
  const result = await fetchPage(url, {
    mode: 'fast',
    extractNextData: false,
    timeoutMs,
    useResidentialEgress: true,
    jobId,
  });
  const html = typeof result.html === 'string' ? result.html : '';
  if (html.length > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes (via egress) from ${url}`);
  return { status: Number(result.status) || 0, html, finalUrl: url, viaEgress: true };
}

async function readTextCapped(response, maxBytes, controller) {
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      controller.abort();
      throw new Error(`Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(concatBytes(chunks, received));
}

function concatBytes(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const ENTITY_MAP = Object.freeze(Object.assign(Object.create(null), {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}));

export function decodeEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]{1,8});/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.hasOwn(ENTITY_MAP, key) ? ENTITY_MAP[key] : match;
    });
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

export function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Resolve a possibly-relative href against a base URL. */
export function absoluteUrl(href, base = 'https://dev.events/') {
  if (!href) return '';
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

export const isDevEventsUrl = (url) => !!policeUrl(url, { allow: DEV_EVENTS_HOSTS, schemes: ['https:', 'http:'] });
export const isLumaUrl = (url) => !!policeUrl(url, { allow: LUMA_HOSTS, schemes: ['https:', 'http:'] });
export const isMeetupUrl = (url) => !!policeUrl(url, { allow: MEETUP_HOSTS, schemes: ['https:', 'http:'] });

/** Every <a ...>text</a> in a fragment, as { href, text }. */
export function extractAnchors(fragment) {
  const anchors = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(fragment)) !== null) {
    const hrefMatch = match[1].match(/\bhref\s*=\s*"([^"]*)"/i) || match[1].match(/\bhref\s*=\s*'([^']*)'/i);
    anchors.push({ href: hrefMatch ? decodeEntities(hrefMatch[1]) : '', text: stripTags(match[2]) });
  }
  return anchors;
}

/** Parse every JSON-LD block in a fragment; malformed blocks are skipped. */
export function extractJsonLd(fragment) {
  const blocks = [];
  const re = /<script[^>]*type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(fragment)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      blocks.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // ignore unparseable block
    }
  }
  return blocks;
}

/** The "showing 30 out of 1208 conferences" total, when the page has one. */
export function extractListingTotal(html) {
  const match = html.match(/out of\s+([\d,]+)\s+(?:conferences|meetups|events)/i)
    || html.match(/([\d,]+)\s+(?:conferences|meetups|events)\b/i);
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : null;
}

/** True when the listing offers a further page ("Show more" button). */
export function hasMoreListingPages(html) {
  return /class="[^"]*\bmoreButton\b[^"]*"/i.test(html);
}

/**
 * Split a listing page into its event rows and extract what the scrapers
 * need from each one. Rows are `<div class="row columns is-mobile ...">`;
 * the trailing pagination row (contains <nav>) is skipped.
 *
 * Location comes from the subtitle links, whose hrefs encode the hierarchy:
 *   /EU/NL/Utrecht  (continent/country/city)  — conferences
 *   /meetups/NA/US/CA/San_Francisco            — meetups, with a state level
 *   /ON                                       — online
 * JSON-LD is the fallback for city/country (it puts the country in
 * addressRegion) and the source of truth for dates and the dev.events URL.
 * Rows whose URL does not resolve to dev.events are dropped.
 */
export function extractListingRows(html, { baseUrl = 'https://dev.events/' } = {}) {
  const rows = [];
  const parts = html.split(/<div class="row columns is-mobile/i);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    if (/<nav\b/i.test(chunk)) continue; // pagination / footer row

    const [ld] = extractJsonLd(chunk).filter((b) => b && (b['@type'] === 'EducationEvent' || b['@type'] === 'Event'));

    const titleMatch = chunk.match(/<h2 class="title[^"]*">\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    const titleHref = titleMatch ? (titleMatch[1].match(/href\s*=\s*"([^"]*)"/i) || [])[1] : '';
    const name = decodeEntities(ld?.name || (titleMatch ? stripTags(titleMatch[2]) : ''));
    if (!name) continue;

    // Prefer the JSON-LD dev.events URL: featured rows link their title
    // straight to the sponsor's site while JSON-LD still carries the
    // dev.events page.
    const url = absoluteUrl(ld?.url || titleHref || '', baseUrl);
    if (!isDevEventsUrl(url)) continue;

    const timeMatch = chunk.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i);
    const dateText = timeMatch ? stripTags(timeMatch[1]) : '';

    const subtitleMatch = chunk.match(/<h3 class="subtitle[^"]*">([\s\S]*?)<\/h3>/i);
    const subtitleHtml = subtitleMatch ? subtitleMatch[1] : '';
    const subtitleText = stripTags(subtitleHtml);
    const location = parseLocationLinks(extractAnchors(subtitleHtml), subtitleText);
    // "Angular meetup Online", "Data / Database conference in Utrecht, …",
    // "Certification masterclass for …": the subtitle names the kind.
    const kindMatch = subtitleText.match(/\b(meetup|conference|masterclass|workshop|hackathon|webinar|summit)\b/i);
    const kind = kindMatch ? kindMatch[1].toLowerCase() : '';

    const address = ld?.location?.address || {};
    const city = location.city || (location.isOnline ? 'Online' : '') || decodeEntities(address.addressLocality || '');
    const country = location.country || decodeEntities(address.addressCountry || (location.city ? '' : address.addressRegion) || '');

    rows.push({
      name,
      url,
      dateText,
      startDate: typeof ld?.startDate === 'string' ? ld.startDate : '',
      endDate: typeof ld?.endDate === 'string' ? ld.endDate : (typeof ld?.startDate === 'string' ? ld.startDate : ''),
      city,
      state: location.state,
      country,
      region: location.region, // continent name, e.g. "Europe"
      isOnline: location.isOnline,
      venueAddress: '',
      description: decodeEntities(typeof ld?.description === 'string' ? ld.description : ''),
      organizer: decodeEntities(ld?.organizer?.name || ld?.performer?.name || ''),
      topic: location.topic,
      kind, // 'meetup' | 'conference' | 'masterclass' | … | ''
    });
  }
  return rows;
}

/**
 * Interpret the subtitle's location links by href depth.
 * Returns { topic, region, country, state, city, isOnline }.
 */
export function parseLocationLinks(anchors, subtitleText = '') {
  const out = { topic: '', region: '', country: '', state: '', city: '', isOnline: false };
  const geo = [];
  for (const a of anchors) {
    const href = (a.href || '').replace(/^\/meetups/, '').replace(/^\/conferences/, '');
    if (!href.startsWith('/')) continue;
    const segments = href.split('/').filter(Boolean);
    if (segments.length === 1 && segments[0] === 'ON') { out.isOnline = true; continue; }
    if (segments.length === 1 && /^[A-Z]{2}$/.test(segments[0])) { geo.push({ depth: 1, text: a.text }); continue; }
    if (segments.length >= 2 && /^[A-Z]{2}$/.test(segments[0]) && /^[A-Z]{2}$/.test(segments[1])) { geo.push({ depth: segments.length, text: a.text }); continue; }
    if (segments.length === 1 && !out.topic) out.topic = a.text; // e.g. /data → "Data / Database"
  }
  if (!out.isOnline && /\bonline\b/i.test(subtitleText) && geo.length === 0) out.isOnline = true;
  const byDepth = (d) => geo.find((g) => g.depth === d)?.text || '';
  out.region = byDepth(1);
  out.country = byDepth(2);
  const deepest = geo.reduce((m, g) => Math.max(m, g.depth), 0);
  if (deepest >= 4) { out.state = byDepth(3); out.city = byDepth(deepest); }
  else if (deepest === 3) { out.city = byDepth(3); }
  return out;
}

/**
 * From a dev.events detail page: the event's own URL (iframe preview, then a
 * "Visit" anchor, then any external link that looks event-ish) and a cover
 * image (og:image / twitter:image). Both are sanitised: http(s) only, no
 * private hosts.
 */
export function extractDetail(html) {
  let coverImageUrl = null;
  const metaRe = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = m[1];
    if (!/(?:property|name)\s*=\s*"(?:og:image|twitter:image)"/i.test(attrs)) continue;
    const content = (attrs.match(/content\s*=\s*"([^"]*)"/i) || [])[1];
    const candidate = sanitizeExternalUrl(content?.startsWith('//') ? `https:${content}` : decodeEntities(content || ''));
    if (candidate) {
      coverImageUrl = candidate;
      break;
    }
  }

  const external = (candidate) => {
    const clean = sanitizeExternalUrl(candidate);
    return clean && !isDevEventsUrl(clean) ? clean : null;
  };

  const iframeRe = /<iframe\b([^>]*)>/gi;
  while ((m = iframeRe.exec(html)) !== null) {
    const src = external(decodeEntities((m[1].match(/\bsrc\s*=\s*"([^"]*)"/i) || [])[1] || ''));
    if (src) return { actualUrl: src, coverImageUrl };
  }

  const anchors = extractAnchors(html)
    .map((a) => ({ href: external(a.href), text: a.text }))
    .filter((a) => a.href);
  const visit = anchors.find((a) => a.text.toLowerCase() === 'visit' || a.text.toLowerCase().includes('visit'));
  if (visit) return { actualUrl: visit.href, coverImageUrl };

  const eventish = anchors.find((a) => /event|conference|summit|tickets/i.test(a.href));
  if (eventish) return { actualUrl: eventish.href, coverImageUrl };

  return { actualUrl: null, coverImageUrl };
}

/** The parsed Next.js `__NEXT_DATA__` payload of a page, or null. */
export function extractNextData(html) {
  const match = html.match(/<script\b[^>]*id\s*=\s*"__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** Keys that carry viewer / attendee data and must not be persisted. */
const PAGE_DATA_PII_KEYS = ['initialUserData', 'user', 'self', 'viewer', 'member', 'members', 'guests', 'rsvps', 'attendees', 'tickets', 'session'];

function stripPii(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const key of PAGE_DATA_PII_KEYS) {
    if (key in obj) delete obj[key];
  }
  return obj;
}

/**
 * Luma event enrichment, mirroring the fields the browser version produced.
 * The persisted page blob keeps the event payload the portal renders from but
 * drops guest / user data (same policy as luma-fast-normalize.js).
 */
export function lumaDataFromNextData(data) {
  if (!data) return null;
  let lumaPageData = null;
  if (data?.props?.pageProps) {
    const pageProps = structuredClone(data.props.pageProps);
    stripPii(pageProps);
    if (pageProps.initialData?.data) stripPii(pageProps.initialData.data);
    lumaPageData = { buildId: data.buildId, pageProps };
  }
  const initialData = data?.props?.pageProps?.initialData?.data;
  const eventData = initialData?.event;
  if (!eventData) return { lumaPageData };
  return {
    lumaEventId: eventData.api_id || initialData.api_id,
    timezone: eventData.timezone,
    coverUrl: sanitizeExternalUrl(eventData.cover_url) || null,
    latitude: eventData.coordinate?.latitude,
    longitude: eventData.coordinate?.longitude,
    city: eventData.geo_address_info?.city,
    country: eventData.geo_address_info?.country,
    countryCode: eventData.geo_address_info?.country_code,
    region: eventData.geo_address_info?.region,
    venueAddress: eventData.geo_address_info?.address,
    fullAddress: eventData.geo_address_info?.full_address,
    shortAddress: eventData.geo_address_info?.short_address,
    locationType: eventData.location_type,
    lumaPageData,
  };
}

/**
 * Meetup.com event enrichment, mirroring the fields the browser version
 * produced. Only the event / venue / group parts of the page payload are
 * persisted; the Apollo cache and viewer data are not.
 */
export function meetupDataFromNextData(data) {
  if (!data) return null;
  const pageProps = data?.props?.pageProps;
  const eventData = pageProps?.event || pageProps;
  if (!eventData) return null;
  const venue = eventData?.venue || eventData?.event?.venue;
  const group = eventData?.group || eventData?.event?.group;
  const id = eventData?.id || eventData?.event?.id;
  const title = eventData?.title || eventData?.event?.title;
  if (!id && !title) return null;
  const event = pageProps?.event || eventData?.event || null;
  return {
    meetupEventId: id,
    title,
    description: eventData?.description || eventData?.event?.description,
    timezone: eventData?.timezone || group?.timezone,
    venueName: venue?.name,
    venueAddress: venue?.address,
    city: venue?.city,
    state: venue?.state,
    country: venue?.country,
    latitude: venue?.lat,
    longitude: venue?.lon,
    groupName: group?.name,
    groupUrlname: group?.urlname,
    dateTime: eventData?.dateTime || eventData?.event?.dateTime,
    endTime: eventData?.endTime || eventData?.event?.endTime,
    meetupPageData: event || venue || group
      ? { buildId: data.buildId, pageProps: { event: event ? stripPii(structuredClone(event)) : null, venue: venue ?? null, group: group ? stripPii(structuredClone(group)) : null } }
      : null,
  };
}

/** Next listing page URL: dev.events paginates with `?page=N` on the same path. */
export function listingPageUrl(baseUrl, page) {
  if (page <= 1) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set('page', String(page));
  return u.toString();
}
