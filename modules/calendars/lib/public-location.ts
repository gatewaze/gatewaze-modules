// Shape a calendar's settings.location (the admin CalendarLocation, plus the
// coordinates and source the scraper worker adds — migration 017) for the
// public API. Only known keys leave the server; settings holds other things.
//
// Returns null when the calendar has no usable place, including the
// {type:'global'} the admin Settings form writes by default.

export interface PublicCalendarLocation {
  type: 'city' | 'region' | 'country';
  city: string | null;
  region: string | null;
  country: string | null;
  country_code: string | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
  source: 'luma' | 'events' | 'manual';
}

const TYPES = new Set(['city', 'region', 'country']);
const SOURCES = new Set(['luma', 'events', 'manual']);

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

export function toPublicCalendarLocation(raw: unknown): PublicCalendarLocation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const loc = raw as Record<string, unknown>;

  const city = text(loc.city);
  const region = text(loc.state);
  const country = text(loc.country);
  const cc = text(loc.country_code)?.toUpperCase() ?? null;
  const countryCode = cc && /^[A-Z]{2}$/.test(cc) ? cc : null;
  const continent = text(loc.continent);
  if (!city && !region && !country && !countryCode) return null;

  const lat = typeof loc.latitude === 'number' && Number.isFinite(loc.latitude) && Math.abs(loc.latitude) <= 90 ? loc.latitude : null;
  const lng = typeof loc.longitude === 'number' && Number.isFinite(loc.longitude) && Math.abs(loc.longitude) <= 180 ? loc.longitude : null;
  const hasCoords = lat !== null && lng !== null;

  const type = typeof loc.type === 'string' && TYPES.has(loc.type)
    ?(loc.type as PublicCalendarLocation['type'])
    : city ? 'city' : 'country';
  // A location saved before the worker started tagging sources was typed in
  // by an admin.
  const source = typeof loc.source === 'string' && SOURCES.has(loc.source)
    ? (loc.source as PublicCalendarLocation['source'])
    : 'manual';

  return {
    type,
    city,
    region,
    country,
    country_code: countryCode,
    continent,
    latitude: hasCoords ? lat : null,
    longitude: hasCoords ? lng : null,
    source,
  };
}
