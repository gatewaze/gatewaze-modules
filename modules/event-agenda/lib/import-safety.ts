/**
 * Fetch and text hygiene for the schedule importer
 * (spec-event-agenda-schedule-import §11.1, §11.3).
 *
 * Everything the importer reads is attacker-influenced: a speaker can put
 * anything in a bio, and the schedule URL itself can be typed by an admin.
 * So there are two gates — where we are allowed to fetch from, and what a
 * parsed string is allowed to look like before it reaches the database.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Hosts the importer may fetch. Expanding this is module config, not code. */
export const DEFAULT_HOST_ALLOWLIST = [
  'events.linuxfoundation.org',
  '*.sched.com',
  'i.ytimg.com',
];

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;
const UA = 'Gatewaze-ScheduleImport/1 (+https://gatewaze.org)';

export function hostAllowed(hostname: string, allowlist: string[] = DEFAULT_HOST_ALLOWLIST): boolean {
  const h = String(hostname ?? '').toLowerCase();
  if (!h) return false;
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // ".sched.com"
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === e;
  });
}

/** Private, loopback, link-local and metadata ranges — never fetched. */
export function isPrivateAddress(ip: string): boolean {
  let v = String(ip ?? '').trim();
  if (isIP(v) === 6) {
    const s = v.toLowerCase();
    // An IPv4-mapped IPv6 literal ("::ffff:169.254.169.254") is a valid IPv6
    // address as far as isIP is concerned, and a DNS AAAA record can carry
    // one. Unwrap it and judge the embedded IPv4, or the v6 prefix tests
    // below would wave the metadata address straight through.
    const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) {
      v = mapped[1];
    } else {
      // Also handle the hex form of a mapped address (::ffff:a9fe:a9fe).
      const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hex) {
        const a = parseInt(hex[1], 16);
        const b = parseInt(hex[2], 16);
        v = [(a >> 8) & 255, a & 255, (b >> 8) & 255, b & 255].join('.');
      } else {
        return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
      }
    }
  }
  const parts = v.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export class FetchRefused extends Error {
  constructor(reason: string) { super(`schedule fetch refused: ${reason}`); this.name = 'FetchRefused'; }
}

/**
 * Fetch with the allowlist, a DNS-resolution check against private ranges, a
 * manual redirect walk that re-checks every hop, a timeout and a size cap.
 */
export async function guardedFetch(
  rawUrl: string,
  allowlist: string[] = DEFAULT_HOST_ALLOWLIST,
): Promise<{ ok: boolean; status: number; text: string }> {
  let url = String(rawUrl ?? '');
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try { u = new URL(url); } catch { throw new FetchRefused(`not a URL: ${url.slice(0, 80)}`); }
    if (u.protocol !== 'https:') throw new FetchRefused(`non-https scheme ${u.protocol}`);
    if (!hostAllowed(u.hostname, allowlist)) throw new FetchRefused(`host not allowlisted: ${u.hostname}`);

    // Resolve before connecting so a hostname pointing at a private address
    // is refused rather than fetched.
    try {
      const addrs = await lookup(u.hostname, { all: true });
      if (addrs.length === 0) throw new FetchRefused(`no address for ${u.hostname}`);
      for (const a of addrs) {
        if (isPrivateAddress(a.address)) throw new FetchRefused(`${u.hostname} resolves to private ${a.address}`);
      }
    } catch (err) {
      if (err instanceof FetchRefused) throw err;
      throw new FetchRefused(`DNS failed for ${u.hostname}`);
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(u.toString(), {
        redirect: 'manual',
        signal: ctl.signal,
        headers: { 'User-Agent': UA },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, status: res.status, text: '' };
      url = new URL(loc, u).toString(); // re-checked at the top of the loop
      continue;
    }

    if (!res.ok) return { ok: false, status: res.status, text: '' };

    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) throw new FetchRefused(`response exceeds ${MAX_BYTES} bytes`);

    // Stream and abort once over the cap, rather than buffering the whole
    // body and checking afterwards: content-length can be absent (chunked) or
    // simply untrue, which would make the cap advisory against exactly the
    // response it exists to stop.
    if (!res.body) return { ok: true, status: res.status, text: '' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new FetchRefused(`response exceeds ${MAX_BYTES} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, status: res.status, text };
  }
  throw new FetchRefused('too many redirects');
}

/** Per-field caps from §11.3. */
export const LIMITS = {
  title: 300,
  role: 120,
  company: 120,
  name: 120,
  bio: 2000,
  synopsis: 5000,
  location: 200,
  track: 120,
  language: 60,
  url: 500,
} as const;

/** Hosts a speaker avatar may be hot-linked from. */
export const AVATAR_HOST_ALLOWLIST = ['*.sched.com', 'sched.com', '*.amazonaws.com', '*.cloudfront.net'];

/**
 * Validate an avatar URL before it is stored and later loaded by every
 * viewer's browser.
 *
 * Imported avatars are hot-linked, not copied (§11.2), so the stored URL IS
 * the request a visitor's browser will make. "Any https URL" is therefore not
 * good enough: it would let whoever controls the programme page choose a host
 * that sees every viewer of the agenda. Cleaned, length-capped, https-only and
 * host-allowlisted; anything else becomes null.
 */
export function safeAvatarUrl(value: unknown, allowlist: string[] = AVATAR_HOST_ALLOWLIST): string | null {
  // Reject over-length rather than letting clean() truncate: a truncated URL
  // is a broken image on every page that renders it, which is worse than no
  // avatar at all.
  if (typeof value === 'string' && value.length > LIMITS.url) return null;
  const s = clean(value, LIMITS.url);
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!hostAllowed(u.hostname, allowlist)) return null;
  return u.toString();
}

/**
 * Strip control characters, collapse whitespace, drop HTML tags outright
 * (rather than escaping them) and cap to a field limit. Returns null for
 * anything empty once cleaned.
 *
 * What this does NOT do: it does not escape quotes or ampersands, so a value
 * like `" onmouseover="…` survives it untouched. That is deliberate —
 * escaping at the source would corrupt legitimate programme text (company
 * names contain ampersands, titles contain quotes) — but it means **every
 * sink must still escape for its own context**. React/JSX does this; a
 * hand-built HTML or email template does not. Spec §11.3 requires sanitising
 * at the sink as well as the source, and this function is only the source half.
 */
export function clean(value: unknown, max: number): string | null {
  if (value == null) return null;
  let s = String(value);
  s = s.replace(/<[^>]*>/g, ' ');           // tags dropped, not escaped
  // Control characters (0x00-0x1F and 0x7F) removed by code point, not by a
  // regex literal — writing the escapes inline put real control bytes in
  // this file and made git treat it as binary.
  s = Array.from(s).map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max).trim() : s;
}
