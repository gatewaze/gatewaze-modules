/**
 * SSRF guard for ingest (spec §10.1). Applied to the listing/stock URL AND every
 * gallery image URL. v1's only source is Auto Trader, so a HOST ALLOWLIST is the
 * first line of defence; on top of that we require https, resolve the hostname,
 * and reject any address in a private/loopback/link-local/ULA/metadata range
 * (defence in depth + protection if the allowlist is widened later).
 *
 * Note: for full DNS-rebind protection the connection should be pinned to the
 * vetted IP. undici's fetch does not expose per-request IP pinning cleanly; v1
 * resolves-then-checks and (preferably) routes through the residential egress
 * proxy (§12), which terminates outside the cluster network. This is tracked.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { VehicleVideoError } from './errors.js';

const DEFAULT_ALLOWED = [
  'autotrader.co.uk',
  'm.atcdn.co.uk',
];

export function allowedHosts(): string[] {
  const raw = process.env.VEHICLE_VIDEO_ALLOWED_HOSTS;
  const list = (raw && raw.trim() ? raw : DEFAULT_ALLOWED.join(','))
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED;
}

/** host === allowed OR host endsWith `.${allowed}` (subdomain). */
export function hostAllowed(host: string, allow: string[] = allowedHosts()): boolean {
  const h = host.toLowerCase();
  return allow.some((a) => h === a || h.endsWith(`.${a}`));
}

function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true; // link-local / ULA
    if (lower.startsWith('::ffff:')) return ipIsPrivate(lower.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // not a valid IP → treat as unsafe
}

export interface SafeUrl {
  url: URL;
  /** Resolved IP (best-effort) for logging/pinning. */
  ip?: string;
}

/**
 * Validate a URL for ingest. Throws VehicleVideoError('SCRAPE_BLOCKED_URL') on
 * any violation (scheme, host allowlist, private IP, resolve failure).
 */
export async function assertSafeUrl(raw: string, allow: string[] = allowedHosts()): Promise<SafeUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VehicleVideoError('SCRAPE_BLOCKED_URL', 'scrape', `invalid URL: ${String(raw).slice(0, 120)}`, 400);
  }
  if (url.protocol !== 'https:') {
    throw new VehicleVideoError('SCRAPE_BLOCKED_URL', 'scrape', `scheme not allowed: ${url.protocol}`, 400);
  }
  if (!hostAllowed(url.hostname, allow)) {
    throw new VehicleVideoError(
      'SCRAPE_BLOCKED_URL',
      'scrape',
      `host not in allowlist (${allow.join(', ')}): ${url.hostname}`,
      400,
    );
  }
  // If the host is a literal IP, check it directly; else resolve and check.
  if (isIP(url.hostname)) {
    if (ipIsPrivate(url.hostname)) {
      throw new VehicleVideoError('SCRAPE_BLOCKED_URL', 'scrape', `blocked IP: ${url.hostname}`, 400);
    }
    return { url, ip: url.hostname };
  }
  let ip: string;
  try {
    const res = await lookup(url.hostname);
    ip = res.address;
  } catch (err) {
    throw new VehicleVideoError('SCRAPE_BLOCKED_URL', 'scrape', `DNS resolve failed: ${(err as Error).message}`, 400);
  }
  if (ipIsPrivate(ip)) {
    throw new VehicleVideoError('SCRAPE_BLOCKED_URL', 'scrape', `host resolves to a blocked IP (${ip})`, 400);
  }
  return { url, ip };
}
