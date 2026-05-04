/**
 * Geocoding helpers for event venues + nearby hotels.
 *
 * Uses Nominatim (https://nominatim.org/) — the free OpenStreetMap geocoder.
 * Why Nominatim:
 *   - No API key, no monthly cost, works the moment a self-hoster pulls the
 *     module.
 *   - Accepts UK postcodes ("DH1 4DJ"), US ZIP codes ("94043"), and full
 *     addresses uniformly, so the admin form can have a single "postcode /
 *     zip" field per the spec ("interchangeable").
 *
 * Rate limit:
 *   Nominatim asks for ≤ 1 req/sec from any one source. The admin form only
 *   geocodes on save (one hotel at a time, behind a button click), so the
 *   limit is academic; we still set a polite User-Agent and let callers pass
 *   their own `fetch` for testing.
 *
 * Distance:
 *   Haversine formula — accurate enough for "list nearest hotels first"
 *   ranking. Returned in metres so the renderer can display km, miles, etc.
 */

export interface GeocodeResult {
  lat: number;
  lng: number;
  /** Display name returned by Nominatim — useful for "Did you mean…?" UX. */
  displayName: string;
}

export interface GeocodeOptions {
  /** Override fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** Override the Nominatim base URL (e.g. for self-hosted instances). */
  baseUrl?: string;
  /** User-Agent string — Nominatim's usage policy requires one. */
  userAgent?: string;
  /**
   * ISO-3166-1 alpha-2 country code(s) to bias the search.
   * Helpful when a postcode like "10001" could be valid in multiple countries.
   */
  countryCodes?: string[];
}

const DEFAULT_BASE_URL = 'https://nominatim.openstreetmap.org';
const DEFAULT_USER_AGENT = 'gatewaze-events-module (https://github.com/gatewaze/gatewaze-modules)';

/**
 * Geocode a postcode/zip-style input. Falls back to free-text search if the
 * postcode-specific endpoint returns no results.
 *
 * Returns null when nothing matches — caller decides whether to surface "we
 * couldn't find that, please check the postcode" or store coordinates as
 * null and let the user manually enter them later.
 */
export async function geocodePostcode(
  query: string,
  opts: GeocodeOptions = {},
): Promise<GeocodeResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const fetchFn = opts.fetch ?? globalThis.fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  // First try the structured `postalcode` field — this gives a higher hit
  // rate for partial/abbreviated postcodes than free-text search.
  const params = new URLSearchParams({
    format: 'json',
    limit: '1',
    addressdetails: '0',
    postalcode: trimmed,
  });
  if (opts.countryCodes && opts.countryCodes.length > 0) {
    params.set('countrycodes', opts.countryCodes.join(',').toLowerCase());
  }

  const structuredUrl = `${baseUrl}/search?${params.toString()}`;
  const structured = await callNominatim(fetchFn, structuredUrl, userAgent);
  if (structured) return structured;

  // Fall back to free-text search — handles "Premier Inn, DH1 4DJ" inputs.
  const freeParams = new URLSearchParams({
    format: 'json',
    limit: '1',
    q: trimmed,
  });
  if (opts.countryCodes && opts.countryCodes.length > 0) {
    freeParams.set('countrycodes', opts.countryCodes.join(',').toLowerCase());
  }
  return callNominatim(fetchFn, `${baseUrl}/search?${freeParams.toString()}`, userAgent);
}

async function callNominatim(
  fetchFn: typeof globalThis.fetch,
  url: string,
  userAgent: string,
): Promise<GeocodeResult | null> {
  const res = await fetchFn(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json',
    },
  });
  if (!res.ok) return null;

  const body = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (!Array.isArray(body) || body.length === 0) return null;

  const first = body[0];
  const lat = Number.parseFloat(first.lat);
  const lng = Number.parseFloat(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng, displayName: first.display_name };
}

/**
 * Haversine great-circle distance between two lat/lng points, in metres.
 * Accurate to within ~0.5 % for distances < ~1000 km, which is well inside
 * "list nearby hotels" tolerance.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000; // Earth radius in metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Format a metres distance for display. Uses miles for en-US/en-GB-ish
 * locales by default — UK uses miles for road distances despite metric
 * everywhere else, which is the use-case this is built for.
 *
 * Caller can pass `unit: 'km'` to force kilometres.
 */
export function formatDistance(
  meters: number,
  opts: { unit?: 'mi' | 'km' } = {},
): string {
  const unit = opts.unit ?? 'mi';
  if (unit === 'km') {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
  }
  // miles
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters * 1.0936)} yd`;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

// ============================================================================
// Driving-route lookup (OSRM)
//
// OSRM (https://project-osrm.org/) is the open-source routing engine that
// powers OpenStreetMap. The public demo at router.project-osrm.org is fine
// for low-volume admin saves; production deployments self-host (single
// container with the relevant region's PBF extract).
//
// We only need driving duration + distance, so we hit the cheap `/route`
// endpoint with `overview=false` (skip the polyline geometry — we don't
// render the route, only the time/distance numbers).
// ============================================================================

export interface DrivingRoute {
  /** Driving distance via the road network, in metres. */
  distanceMeters: number;
  /** Estimated driving time in seconds (free-flow, no traffic model). */
  durationSeconds: number;
}

export interface DrivingRouteOptions {
  fetch?: typeof globalThis.fetch;
  /** Defaults to https://router.project-osrm.org */
  baseUrl?: string;
  /**
   * Routing profile. OSRM's public demo only ships `driving`; self-hosted
   * instances may also expose `cycling` / `foot`. Default is `driving` —
   * which is what "taxi time" wants.
   */
  profile?: 'driving' | 'cycling' | 'foot';
}

const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';

/**
 * Fetch the driving route between two points. Returns null on any error —
 * caller should treat that as "drive time unknown" and either omit the
 * column or fall back to a haversine-based estimate.
 */
export async function getDrivingRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  opts: DrivingRouteOptions = {},
): Promise<DrivingRoute | null> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_OSRM_BASE_URL).replace(/\/$/, '');
  const profile = opts.profile ?? 'driving';

  // OSRM uses lon,lat order in the URL — easy to get wrong.
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `${baseUrl}/route/v1/${profile}/${coords}?overview=false&alternatives=false&steps=false`;

  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = (await res.json()) as {
    code?: string;
    routes?: Array<{ distance: number; duration: number }>;
  };
  if (body.code !== 'Ok' || !body.routes || body.routes.length === 0) return null;

  const route = body.routes[0];
  if (!Number.isFinite(route.distance) || !Number.isFinite(route.duration)) return null;
  return {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
  };
}

/**
 * Format a duration (in seconds) as a human label like "12 min" or "1 hr 24 min".
 * Used for taxi-time labels on hotel rows + drive-time on RSVP confirmations.
 */
export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return '< 1 min';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (rem === 0) return `${hrs} hr`;
  return `${hrs} hr ${rem} min`;
}
