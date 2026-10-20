/**
 * Fetch a URL a scraped page handed us without letting it reach inside the
 * cluster.
 *
 * Scrapers save whatever cover-image URL a source page names, and the worker
 * then downloads it with the service-role pod's network access and republishes
 * the bytes from the public media bucket. Without a guard a source could name
 * (or redirect to) cloud metadata, a cluster service or anything on the pod
 * network and read the response back from the bucket.
 *
 * The guard:
 *   - allows http and https only, with no credentials in the URL;
 *   - checks every address a hostname resolves to, inside the socket's own
 *     DNS lookup, so the address checked is the address connected to (a DNS
 *     answer that changes between a check and the connect cannot slip past);
 *   - checks IP-literal hosts directly, since Node skips the lookup for them;
 *   - follows redirects by hand and runs every hop through the same checks;
 *   - times out, and streams the body with a byte cap.
 *
 * Same rules as event-agenda's import-safety.ts guardedFetchBytes, in plain JS
 * because the scraper worker runs these scripts without a TypeScript build.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export class FetchRefused extends Error {
  constructor(reason) {
    super(`fetch refused: ${reason}`);
    this.name = 'FetchRefused';
  }
}

/** Private, loopback, link-local, CGNAT, metadata and multicast ranges. */
export function isPrivateAddress(ip) {
  let v = String(ip ?? '').trim().replace(/^\[|\]$/g, '');
  if (isIP(v) === 6) {
    const s = v.toLowerCase();
    // An IPv4-mapped IPv6 address ("::ffff:169.254.169.254", or its hex form)
    // is judged by the IPv4 address inside it.
    const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      v = mapped[1];
    } else if (hex) {
      const a = parseInt(hex[1], 16);
      const b = parseInt(hex[2], 16);
      v = [(a >> 8) & 255, a & 255, (b >> 8) & 255, b & 255].join('.');
    } else {
      // "::" prefix covers ::1, :: and the IPv4-compatible ::a.b.c.d forms;
      // 2002: (6to4) and 64:ff9b: (NAT64) embed an IPv4 address too.
      return s.startsWith('::') || s.startsWith('fc') || s.startsWith('fd') ||
        /^fe[89a-f]/.test(s) || s.startsWith('ff') ||
        s.startsWith('64:ff9b:') || s.startsWith('2002:');
    }
  }
  const parts = v.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

// Socket-level lookup: resolve, refuse if any answer is private, and hand the
// vetted answer straight to the connect.
function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'object' && options !== null ? options : { family: options };
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const list = Array.isArray(addrs) ? addrs : [];
    if (list.length === 0) return callback(new FetchRefused(`no address for ${hostname}`));
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) return callback(new FetchRefused(`${hostname} resolves to private ${bad.address}`));
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const httpAgent = new http.Agent({ lookup: guardedLookup });
const httpsAgent = new https.Agent({ lookup: guardedLookup });

function checkUrl(raw, allowHttp) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    throw new FetchRefused('not a URL');
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    throw new FetchRefused(`scheme ${u.protocol} not allowed`);
  }
  if (u.username || u.password) throw new FetchRefused('credentials in URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) throw new FetchRefused(`private address ${host}`);
  return u;
}

/**
 * Fetch with the guard. Returns { status, contentType, buffer, finalUrl,
 * headers } where `headers` is the final response's headers as a lowercase
 * map (so a caller can do conditional GET: send If-None-Match, read etag).
 * A non-2xx final response (including 304) returns its status with an
 * empty buffer.
 *
 * Options:
 *   maxBytes      body cap (default 10 MB)
 *   timeoutMs     per hop (default 20 s)
 *   maxRedirects  hops to follow (default 5; 0 refuses any redirect)
 *   allowHttp     allow plain http (default true)
 *   headers       extra request headers
 */
export async function guardedFetch(rawUrl, options = {}) {
  const {
    maxBytes = 10 * 1024 * 1024,
    timeoutMs = 20_000,
    maxRedirects = 5,
    allowHttp = true,
    headers = {},
  } = options;
  const fetch = (await import('node-fetch')).default;

  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = checkUrl(url, allowHttp);
    const res = await fetch(u.toString(), {
      redirect: 'manual',
      agent: u.protocol === 'https:' ? httpsAgent : httpAgent,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'GatewazeBot/1.0', ...headers },
      compress: true,
      size: 0,
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      res.body?.resume?.();
      if (!loc) return { status: res.status, contentType: '', buffer: Buffer.alloc(0), finalUrl: u.toString(), headers: headerMap(res.headers) };
      if (hop === maxRedirects) break;
      url = new URL(loc, u).toString(); // checked again at the top of the loop
      continue;
    }

    const contentType = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!res.ok) {
      res.body?.resume?.();
      return { status: res.status, contentType, buffer: Buffer.alloc(0), finalUrl: u.toString(), headers: headerMap(res.headers) };
    }

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      res.body?.destroy?.();
      throw new FetchRefused(`response exceeds ${maxBytes} bytes`);
    }

    // Stream with the cap: content-length can be missing or wrong.
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        res.body.destroy();
        throw new FetchRefused(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return { status: res.status, contentType, buffer: Buffer.concat(chunks, total), finalUrl: u.toString(), headers: headerMap(res.headers) };
  }
  throw new FetchRefused('too many redirects');
}

function headerMap(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function') h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
  else if (h.raw) for (const [k, v] of Object.entries(h.raw())) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

const IMAGE_TYPES = /^(image\/[a-z0-9.+-]+|application\/octet-stream|binary\/octet-stream)$/;

/** True when the bytes start like a JPEG, PNG, GIF, WebP or AVIF/HEIF file. */
export function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // PNG
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return true;
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return true;
  if (head.slice(4, 8) === 'ftyp') return true; // AVIF / HEIF
  return false;
}

/**
 * Download a cover image through the guard. Returns { buffer, contentType }
 * or null when the URL does not serve an image.
 */
export async function fetchImage(rawUrl, options = {}) {
  const r = await guardedFetch(rawUrl, { maxBytes: 15 * 1024 * 1024, ...options });
  if (r.status < 200 || r.status >= 300 || r.buffer.length === 0) return null;
  if (r.contentType && !IMAGE_TYPES.test(r.contentType)) return null;
  // The bytes are republished from a public bucket, so check them as well as
  // the header a server chose to send.
  if (!looksLikeImage(r.buffer)) return null;
  return { buffer: r.buffer, contentType: r.contentType };
}
