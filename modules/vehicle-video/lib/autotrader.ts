/**
 * Auto Trader adapter (spec §6, OQ1). v1's only source. Parses:
 *   - the retailer STOCK list (retailerId → vehicles for sale)
 *   - a single CAR-DETAILS listing (gallery images + structured details)
 *
 * Both parse the page's embedded JSON (Next.js `__NEXT_DATA__`) best-effort —
 * Auto Trader revises its markup/JSON periodically, so parsing is defensive and
 * falls back to scanning for image URLs. Fetches are egress-aware (Auto Trader
 * blocks datacentre IPs) and SSRF-host-allowlisted. This is the highest-risk
 * surface (OQ1: robustness + anti-bot + ToS/compliance before GA).
 */

import { assertSafeUrl } from './ssrf-guard.js';
import {
  acquireLease,
  proxiedFetch,
  reportUsage,
  readUsage,
  isEgressUnavailable,
  type EgressLease,
} from './residential-egress.js';
import { VehicleVideoError } from './errors.js';

const STOCK_URL = (retailerId: string) =>
  `https://www.autotrader.co.uk/cars/retailer/stock?retailerId=${encodeURIComponent(retailerId)}`;
const CAR_DETAILS_URL = (listingId: string) =>
  `https://www.autotrader.co.uk/car-details/${encodeURIComponent(listingId)}`;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function egressOn(): boolean {
  const v = (process.env.VEHICLE_VIDEO_RESIDENTIAL_EGRESS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Fetch a URL as text, SSRF-guarded, through a residential lease when enabled,
 *  degrading to a direct fetch on any egress unavailability. */
async function fetchText(rawUrl: string, jobId: string): Promise<string> {
  await assertSafeUrl(rawUrl);
  const headers = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' };

  let lease: EgressLease | null = null;
  if (egressOn()) {
    try {
      lease = await acquireLease({ consumer: 'vehicle-video', targetHost: 'autotrader.co.uk', sticky: true, jobId });
    } catch (err) {
      if (!isEgressUnavailable(err)) throw err;
      lease = null;
    }
  }
  try {
    const doFetch = lease ? proxiedFetch(lease) : fetch;
    const res = await doFetch(rawUrl, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new VehicleVideoError(
        'SCRAPE_FETCH_FAILED',
        'scrape',
        `Auto Trader returned HTTP ${res.status} (anti-bot?) for ${rawUrl.slice(0, 80)}`,
      );
    }
    return await res.text();
  } finally {
    if (lease) {
      const u = readUsage(lease);
      await reportUsage(lease.leaseId, { bytesIn: u.bytesIn, bytesOut: u.bytesOut, requests: u.requests || 1, final: true });
    }
  }
}

/** Extract the __NEXT_DATA__ JSON blob (or the first large application/json script). */
function extractPageJson(html: string): unknown | null {
  const m =
    html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i) ??
    html.match(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Recursively collect https image URLs that look like vehicle photos. */
function collectImageUrls(node: unknown, out: Set<string>): void {
  if (out.size > 60) return;
  if (typeof node === 'string') {
    if (/^https:\/\/[^\s"']+\.(jpe?g|png|webp)(\?|$)/i.test(node) && /atcdn|autotrader/i.test(node)) {
      out.add(node);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectImageUrls(v, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) collectImageUrls(v, out);
  }
}

/** Find the first object under `node` that has all of `keys`. */
function findObjectWith(node: unknown, keys: string[], depth = 0): Record<string, unknown> | null {
  if (depth > 8 || !node || typeof node !== 'object') return null;
  if (!Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    if (keys.every((k) => k in o)) return o;
  }
  const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
  for (const c of children) {
    const found = findObjectWith(c, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

export interface AutoTraderDetails {
  year?: string;
  make?: string;
  model?: string;
  trim?: string;
  body?: string;
  price?: string;
  mileage?: string;
  specs?: string[];
  /** Full dealer advert description — signals the target buyer + the dealer pitch. */
  description?: string;
  seller_name?: string;
  seller_location?: string;
}

/**
 * Extract the React-Router SSR loader data Auto Trader embeds as
 * `window.__staticRouterHydrationData = JSON.parse("…")`. This carries the
 * structured vehicle object (make/model/derivative/price/mileage/spec/
 * description/location) even though the page is a client-hydrated SPA.
 */
export function extractHydrationData(html: string): unknown | null {
  // JSON.parse("<escaped json>") form (most common).
  const m = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\((("(?:[^"\\]|\\.)*"))\)/);
  if (m) {
    try {
      return JSON.parse(JSON.parse(m[1]) as string);
    } catch {
      /* fall through */
    }
  }
  // Raw object form: window.__staticRouterHydrationData = {…};
  const m2 = html.match(/window\.__staticRouterHydrationData\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (m2) {
    try {
      return JSON.parse(m2[1]);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Depth-first find the first object satisfying `pred`. */
function findFirst(node: unknown, pred: (o: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || depth > 14) return null;
  if (!Array.isArray(node) && pred(node as Record<string, unknown>)) return node as Record<string, unknown>;
  for (const v of Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)) {
    const f = findFirst(v, pred, depth + 1);
    if (f) return f;
  }
  return null;
}

function firstString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** Flatten a rich-text node (string | { text|content|value } | array) to plain text. */
function flattenText(node: unknown, depth = 0): string {
  if (node == null || depth > 6) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((n) => flattenText(n, depth + 1)).join(' ');
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const cand = o.text ?? o.content ?? o.value ?? o.children ?? o.paragraph;
    return cand != null ? flattenText(cand, depth + 1) : '';
  }
  return '';
}

/** Build structured details from the hydration data (best-effort, defensive). */
export function detailsFromHydration(hydration: unknown): AutoTraderDetails {
  const d: AutoTraderDetails = {};
  if (!hydration) return d;

  const veh = findFirst(hydration, (o) => 'make' in o && 'model' in o);
  if (veh) {
    d.make = firstString(veh.make);
    d.model = firstString(veh.model);
    d.trim = firstString(veh.derivative ?? veh.trim);
    d.year = firstString(veh.year ?? veh.registrationYear);
    d.body = firstString(veh.bodyType ?? veh.body);
    d.mileage = firstString(veh.mileage ?? veh.odometerReadingMiles);
    d.trim = d.trim ?? firstString(veh.derivative);
  }

  const bt = findFirst(hydration, (o) => 'bodyType' in o || 'fuelType' in o);
  const specs: string[] = [];
  const push = (v: unknown) => { const s = firstString(v); if (s && !specs.includes(s)) specs.push(s); };
  if (bt) {
    d.body = d.body ?? firstString(bt.bodyType);
    push(bt.bodyType); push(bt.fuelType); push(bt.transmission);
    push(bt.engineSize ?? bt.engineSizeLitres); push(bt.emissionClass ?? bt.euroStatus);
  }
  const grab = findFirst(hydration, (o) => 'attentionGrabber' in o);
  if (grab?.attentionGrabber) {
    for (const g of String(grab.attentionGrabber).split(/,|•/)) push(g.trim());
  }
  if (specs.length) d.specs = specs.slice(0, 12);

  const price = findFirst(hydration, (o) => 'priceFormatted' in o || ('price' in o && typeof o.price === 'number'));
  if (price) d.price = firstString(price.priceFormatted) ?? (price.price != null ? `£${price.price}` : undefined);

  // The description node is { title:'Description', text:[ … ] } where items may be
  // plain strings OR nested rich-text objects; flatten to strings only.
  const desc = findFirst(
    hydration,
    (o) => o.title === 'Description' && Array.isArray(o.text) && (o.text as unknown[]).length > 0,
  );
  if (desc && Array.isArray(desc.text)) {
    const parts = (desc.text as unknown[]).map(flattenText).filter((s) => s && s.trim());
    if (parts.length) d.description = parts.join('\n\n').slice(0, 4000);
  }

  const loc = findFirst(hydration, (o) => 'town' in o && ('county' in o || 'postcode' in o));
  if (loc) d.seller_location = [firstString(loc.town), firstString(loc.county)].filter(Boolean).join(', ') || undefined;

  const seller = findFirst(hydration, (o) => 'sellerName' in o || 'dealerName' in o || (('name' in o) && ('town' in o || 'phoneNumber' in o)));
  if (seller) d.seller_name = firstString(seller.sellerName ?? seller.dealerName ?? seller.name);

  return d;
}

export interface CarDetails {
  imageUrls: string[];
  details: AutoTraderDetails;
}

/**
 * Extract vehicle gallery images from an Auto Trader car-details page. The page
 * is a Vite SPA (no __NEXT_DATA__/JSON-LD; details are client-rendered) but the
 * gallery image URLs ARE in the initial HTML on the Auto Trader image CDN
 * (m.atcdn.co.uk/a/media/[wNNN/]<hash>.jpg). The same photo appears at several
 * widths keyed by a shared <hash>; we dedup by hash and pick the widest ≤1600px
 * variant (sharp caps to 1920 anyway), preserving first-seen order.
 */
export function extractAtcdnImages(html: string, max = 60): string[] {
  const re = /https:\/\/[a-z0-9.]*atcdn\.co\.uk\/a\/media\/(?:w(\d+)\/)?([a-f0-9]{16,})\.(?:jpe?g|webp)/gi;
  const best = new Map<string, { url: string; width: number }>();
  const order: string[] = [];
  for (const m of html.matchAll(re)) {
    const width = m[1] ? Number(m[1]) : 100000; // no-width = full res
    const hash = m[2];
    const capped = width > 1600 ? 0 : width; // treat oversized/full as low-priority
    const cur = best.get(hash);
    if (!cur) order.push(hash);
    if (!cur || capped > cur.width) best.set(hash, { url: m[0], width: capped });
  }
  return order.map((h) => best.get(h)!.url).slice(0, max);
}

export async function fetchCarDetails(listingId: string, jobId: string): Promise<CarDetails> {
  const html = await fetchText(CAR_DETAILS_URL(listingId), jobId);
  const json = extractPageJson(html);
  const imageSet = new Set<string>();
  if (json) collectImageUrls(json, imageSet);
  // Primary for the current Auto Trader SPA markup: scan the HTML for CDN images.
  if (imageSet.size === 0) for (const u of extractAtcdnImages(html)) imageSet.add(u);

  // Structured details come from the React-Router SSR hydration blob.
  const details = detailsFromHydration(extractHydrationData(html));

  return { imageUrls: Array.from(imageSet).slice(0, 60), details };
}

/** Confirm a URL is a reachable image (small GET; logos are a few KB). */
async function probeImage(rawUrl: string): Promise<boolean> {
  try {
    await assertSafeUrl(rawUrl);
    const res = await fetch(rawUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    return ct.startsWith('image/');
  } catch {
    return false;
  }
}

// The dealer's own logo is NOT on the retailer stock page (that only carries Auto
// Trader's site chrome — favicons/touch-icons under /static/media/logos). It lives
// on the DEALER-BRANDING path, keyed by the retailerId, and is also embedded on
// each car-details page's seller panel:
//   https://m.atcdn.co.uk/dealer-logo/at2/adbranding/<retailerId>/images/<file>
// Auto Trader's own assets (/static/media/logos) and finance partners
// (/service-partner-logo) must be excluded.
const DEALER_BRANDING = (retailerId: string, file: string) =>
  `https://m.atcdn.co.uk/dealer-logo/at2/adbranding/${encodeURIComponent(retailerId)}/images/${file}`;
const DEALER_LOGO_FILES = ['fpa_logo.gif', 'fpa_logo.png', 'fpa_logo.jpg', 'logo.gif', 'logo.png', 'logo.jpg'];
const isDealerLogoUrl = (u: string) =>
  /atcdn\.co\.uk\/dealer-logo\//i.test(u) &&
  !/service-partner-logo|static\/media\/logos/i.test(u);

/**
 * Find the DEALER's logo (not Auto Trader's own). Tries the deterministic
 * dealer-branding path for the retailerId first (verified pattern), then falls
 * back to scanning a car-details page's seller panel. Returns null if only Auto
 * Trader's site chrome is present.
 */
export async function fetchRetailerLogo(retailerId: string, jobId: string): Promise<string | null> {
  // 1) deterministic dealer-branding path for this retailer.
  for (const f of DEALER_LOGO_FILES) {
    const u = DEALER_BRANDING(retailerId, f);
    if (await probeImage(u)) return u;
  }
  // 2) fallback: a car-details page embeds the dealer logo in the seller panel.
  try {
    const stock = await fetchText(STOCK_URL(retailerId), jobId);
    const stockLogo = [...stock.matchAll(/https:\/\/[a-z0-9.]*atcdn\.co\.uk\/dealer-logo\/[^\s"'<>\\]+\.(?:png|jpe?g|gif|webp|svg)/gi)]
      .map((m) => m[0])
      .find((u) => isDealerLogoUrl(u) && u.includes(`/${retailerId}/`));
    if (stockLogo && (await probeImage(stockLogo))) return stockLogo;

    const firstListing = (await fetchRetailerStock(retailerId, jobId))[0]?.listing_id;
    if (firstListing) {
      const car = await fetchText(CAR_DETAILS_URL(firstListing), jobId);
      const carLogo = [...car.matchAll(/https:\/\/[a-z0-9.]*atcdn\.co\.uk\/dealer-logo\/[^\s"'<>\\]+\.(?:png|jpe?g|gif|webp|svg)/gi)]
        .map((m) => m[0])
        .filter(isDealerLogoUrl)
        .sort((a, b) => (b.includes(`/${retailerId}/`) ? 1 : 0) - (a.includes(`/${retailerId}/`) ? 1 : 0))[0];
      if (carLogo && (await probeImage(carLogo))) return carLogo;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export interface StockVehicle {
  listing_id: string;
  url: string;
  title?: string;
  price?: string;
  mileage?: string;
  thumbnail_url?: string;
}

export async function fetchRetailerStock(retailerId: string, jobId: string): Promise<StockVehicle[]> {
  const html = await fetchText(STOCK_URL(retailerId), jobId);
  const json = extractPageJson(html);
  const vehicles: StockVehicle[] = [];
  const seen = new Set<string>();

  // Best-effort: find listing ids (Auto Trader car-details ids are numeric) and
  // any nearby title/price. Prefer structured objects; fall back to id scan.
  const scan = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (!Array.isArray(node)) {
      const o = node as Record<string, unknown>;
      const id =
        (o.advertId as string) ?? (o.listingId as string) ?? (o.id as string) ?? undefined;
      const idStr = id != null ? String(id) : '';
      if (/^\d{6,}$/.test(idStr) && !seen.has(idStr)) {
        seen.add(idStr);
        vehicles.push({
          listing_id: idStr,
          url: CAR_DETAILS_URL(idStr),
          title:
            (o.title as string) ??
            ([o.make, o.model].filter(Boolean).join(' ') || undefined),
          price: o.price != null ? String(o.price) : undefined,
          mileage: o.mileage != null ? String(o.mileage) : undefined,
          thumbnail_url: typeof o.image === 'string' ? o.image : undefined,
        });
      }
    }
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const c of children) scan(c);
  };
  if (json) scan(json);

  // Raw-HTML fallback: pull /car-details/<id> hrefs.
  if (vehicles.length === 0) {
    const re = /\/car-details\/(\d{6,})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && vehicles.length < 200) {
      const id = m[1];
      if (!seen.has(id)) {
        seen.add(id);
        vehicles.push({ listing_id: id, url: CAR_DETAILS_URL(id) });
      }
    }
  }
  return vehicles;
}
