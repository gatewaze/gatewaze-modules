/**
 * Per-recipient / per-send resolution for the Local Events and Virtual Events
 * email blocks (spec: location-dependent newsletter blocks, v1 — radius only).
 *
 * The blocks emit a single self-contained token in their publish HTML
 * ({{local_events_block}} / {{virtual_events_block}}) plus a config marker
 * comment. The send-engine binding resolves each token to either a rendered
 * HTML card list OR an empty string — an empty string makes the whole block
 * disappear for that recipient (true per-recipient omission under SendGrid's
 * shared-body legacy substitutions, which insert values verbatim, not escaped).
 *
 *   - Local Events  — per recipient. Resolved from newsletter_local_events()
 *     against the recipient's location (attributes.location "lat,lng" or city).
 *     Cached by coarse area so recipients in the same metro share one lookup.
 *   - Virtual Events — global (same for every recipient). Resolved once per send
 *     from newsletter_virtual_events().
 *
 * Pure helpers (parse/render/pickLoc/areaKey) are unit-tested; the resolve*
 * functions take a supabase client and are exercised against the DB.
 */

// Minimal supabase surface we use (avoids pulling the full client type into the worker).
export interface EventRpcClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface EventRow {
  id: string;
  event_id: string;
  event_title: string;
  event_start: string | null;
  event_timezone: string | null;
  event_city: string | null;
  event_slug: string | null;
  event_url: string | null;
  event_image: string | null;
  match_tier: string | null;
}

export interface RecipientLoc {
  lat: number | null;
  lon: number | null;
  city: string | null;
}

export const LOCAL_TOKEN = '{{local_events_block}}';
export const VIRTUAL_TOKEN = '{{virtual_events_block}}';
const LOCAL_MARKER_RE = /<!--gw-local-events:([\s\S]*?)-->/;
const VIRTUAL_MARKER_RE = /<!--gw-virtual-events:([\s\S]*?)-->/;
const MILES_TO_KM = 1.60934;

export interface LocalConfig { heading: string; intro: string; max: number; radiusKm: number }
export interface VirtualConfig { heading: string; intro: string; max: number }

const LOCAL_DEFAULTS: LocalConfig = { heading: 'Upcoming Events Near You', intro: '', max: 3, radiusKm: 100 * MILES_TO_KM };
const VIRTUAL_DEFAULTS: VirtualConfig = { heading: 'Upcoming Virtual Events', intro: '', max: 5 };

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function cleanStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Parse the Local Events config marker; falls back to defaults on any error. */
export function parseLocalConfig(html: string): LocalConfig {
  const m = html.match(LOCAL_MARKER_RE);
  if (!m) return { ...LOCAL_DEFAULTS };
  try {
    const j = JSON.parse(m[1]) as Record<string, unknown>;
    const miles = clampInt(j.r, 1, 12000, 100);
    return {
      heading: cleanStr(j.h) || LOCAL_DEFAULTS.heading,
      intro: cleanStr(j.i),
      max: clampInt(j.m, 1, 20, LOCAL_DEFAULTS.max),
      radiusKm: miles * MILES_TO_KM,
    };
  } catch {
    return { ...LOCAL_DEFAULTS };
  }
}

/** Parse the Virtual Events config marker; falls back to defaults on any error. */
export function parseVirtualConfig(html: string): VirtualConfig {
  const m = html.match(VIRTUAL_MARKER_RE);
  if (!m) return { ...VIRTUAL_DEFAULTS };
  try {
    const j = JSON.parse(m[1]) as Record<string, unknown>;
    return {
      heading: cleanStr(j.h) || VIRTUAL_DEFAULTS.heading,
      intro: cleanStr(j.i),
      max: clampInt(j.m, 1, 20, VIRTUAL_DEFAULTS.max),
    };
  } catch {
    return { ...VIRTUAL_DEFAULTS };
  }
}

/** Remove the block config-marker comments from the send HTML once parsed. */
export function stripEventMarkers(html: string): string {
  return html.replace(LOCAL_MARKER_RE, '').replace(VIRTUAL_MARKER_RE, '');
}

/**
 * Recipient location from people.attributes. Supports `location` = "lat,lng"
 * (the IP-geo format) and separate lat/lon keys; city as a fallback tier.
 */
export function pickLoc(attrs: Record<string, unknown> | null | undefined): RecipientLoc {
  const a = attrs ?? {};
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v
      : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  let lat = num(a.lat ?? a.latitude);
  let lon = num(a.lon ?? a.longitude);
  if ((lat === null || lon === null) && typeof a.location === 'string') {
    const m = a.location.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { lat = Number(m[1]); lon = Number(m[2]); }
  }
  const city = typeof a.city === 'string' && a.city.trim() ? a.city.trim() : null;
  // Guard against out-of-range coords (dirty data) → treat as no coords.
  if (lat !== null && (lat < -90 || lat > 90)) lat = null;
  if (lon !== null && (lon < -180 || lon > 180)) lon = null;
  if (lat === null || lon === null) { lat = null; lon = null; }
  return { lat, lon, city };
}

/** Coarse cache key: ~11km geo cells share a lookup; else city; else none. */
export function areaKey(loc: RecipientLoc): string | null {
  if (loc.lat !== null && loc.lon !== null) return `geo:${loc.lat.toFixed(1)}|${loc.lon.toFixed(1)}`;
  if (loc.city) return `city:${loc.city.toLowerCase()}`;
  return null; // no location → no local events, no lookup
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDate(iso: string | null, tz: string | null): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}
function eventUrl(ev: EventRow, portalBaseUrl: string | null): string {
  if (ev.event_url) return ev.event_url;
  const base = (portalBaseUrl || '').replace(/\/+$/, '');
  return base && ev.event_id ? `${base}/events/${ev.event_id}` : '';
}

/**
 * Email-safe HTML for a list of events. Returns '' for an empty list so the
 * caller can omit the block entirely. Table-based + inline styles for client
 * compatibility.
 */
export function renderEventsHtml(
  events: EventRow[],
  opts: { heading: string; intro: string; portalBaseUrl: string | null },
): string {
  if (!events.length) return '';
  const rows = events.map((ev) => {
    const url = eventUrl(ev, opts.portalBaseUrl);
    const title = esc(ev.event_title || 'Event');
    const meta = [fmtDate(ev.event_start, ev.event_timezone), ev.event_city ? esc(ev.event_city) : '']
      .filter(Boolean).join(' &middot; ');
    const titleHtml = url
      ? `<a href="${esc(url)}" style="color:#111827;text-decoration:none;font-weight:600;font-size:15px;">${title}</a>`
      : `<span style="color:#111827;font-weight:600;font-size:15px;">${title}</span>`;
    return (
      `<tr><td style="padding:10px 0;border-bottom:1px solid #E5E7EB;">` +
      titleHtml +
      (meta ? `<div style="color:#6B7280;font-size:13px;margin-top:2px;">${meta}</div>` : '') +
      `</td></tr>`
    );
  }).join('');
  const introHtml = opts.intro
    ? `<p style="margin:0 0 12px;color:#374151;font-size:14px;">${esc(opts.intro)}</p>` : '';
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="border-collapse:collapse;background:#F9FAFB;border-radius:10px;padding:20px;margin:8px 0;">` +
    `<tr><td style="padding:20px;">` +
    `<h2 style="margin:0 0 8px;color:#111827;font-size:18px;">${esc(opts.heading)}</h2>` +
    introHtml +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">` +
    rows +
    `</table></td></tr></table>`
  );
}

/** Resolve upcoming local (in-person) events for a recipient location. */
export async function resolveLocalEvents(
  supabase: EventRpcClient, loc: RecipientLoc, cfg: LocalConfig, afterIso: string,
): Promise<EventRow[]> {
  if (loc.lat === null && !loc.city) return []; // no location → nothing local
  const { data, error } = await supabase.rpc('newsletter_local_events', {
    p_lat: loc.lat, p_lon: loc.lon, p_city: loc.city, p_after: afterIso, p_radius_km: cfg.radiusKm, p_limit: cfg.max,
  });
  if (error) return [];
  return (data as EventRow[]) ?? [];
}

/** Resolve upcoming virtual events (global). */
export async function resolveVirtualEvents(
  supabase: EventRpcClient, cfg: VirtualConfig, afterIso: string,
): Promise<EventRow[]> {
  const { data, error } = await supabase.rpc('newsletter_virtual_events', { p_after: afterIso, p_limit: cfg.max });
  if (error) return [];
  return (data as EventRow[]) ?? [];
}
