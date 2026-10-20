/**
 * The one way this module fetches anything from the internet.
 *
 * Direct path: the scrapers module's guarded fetch, which checks every
 * address a hostname resolves to INSIDE the socket's own DNS lookup (so the
 * address checked is the address connected to), re-polices every redirect
 * hop, and caps the body. We pass `allowHttp: false` and explicit caps
 * because its defaults allow http and 10 MB. Conditional GET validators go
 * in as request headers and come back in the `headers` it now returns.
 *
 * Residential path (per source, see FeedScraper): the residential-egress
 * module's in-process ProxyAgent. A feed is raw XML with If-None-Match
 * headers, which the rendered-HTML scrapling service would strip, so the
 * proxy has to be in-process. DNS is resolved by the remote proxy, so the
 * destination is policed syntactically here; this path is safe only while
 * the proxy is a residential provider outside the cluster network. `undici`
 * is declared in this module's package.json so it is baked into the worker
 * image; if it is missing the fetch falls back to direct with a warning.
 *
 * Both paths return the same shape: { status, headers, text, finalUrl, via }.
 * A 304 comes back with status 304 and empty text.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Sibling modules in any materialised root: <root>/<module>/... → <root>/scrapers/...
const SCRAPERS_LIB = path.resolve(HERE, '..', '..', 'scrapers', 'scripts', 'lib');
const EGRESS_LIB = path.resolve(HERE, '..', '..', 'residential-egress', 'lib');

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 GatewazeDiscovery/1.0 (+https://gatewaze.org)';
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5';

let _guarded = null;
async function guarded() {
  if (_guarded) return _guarded;
  _guarded = await import(path.join(SCRAPERS_LIB, 'guarded-fetch.js'));
  return _guarded;
}

export class FetchRefusedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'FetchRefused';
  }
}

// Names that are never public sites: cluster and local suffixes, single
// labels (`redis`, `postgres`), trailing-dot forms.
const INTERNAL_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.svc|.*\.svc\..*|.*\.cluster\.local|.*\.home\.arpa)$/i;

/**
 * Validate a URL the way the guard does, without fetching: https only, no
 * credentials, no IP literal, no internal-looking or single-label host, no
 * trailing dot, no port other than 443.
 * @returns {URL}
 */
export function policeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new FetchRefusedError('not a URL');
  }
  if (u.protocol !== 'https:') throw new FetchRefusedError(`scheme ${u.protocol} not allowed`);
  if (u.username || u.password) throw new FetchRefusedError('credentials in URL');
  if (u.port && u.port !== '443') throw new FetchRefusedError('non-standard port');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.endsWith('.') || !host.includes('.') || INTERNAL_HOST.test(host)) throw new FetchRefusedError('host not allowed');
  if (isIP(host)) throw new FetchRefusedError('host not allowed');
  if (u.toString().length > 2048) throw new FetchRefusedError('URL too long');
  return u;
}

/** Strip anything that looks like credentials or a proxy URL out of a message before it is logged or stored. */
export function scrubSecrets(msg, proxyUrl = null) {
  let s = String(msg ?? '');
  if (proxyUrl) s = s.split(proxyUrl).join('[proxy]');
  return s.replace(/[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/gi, '$&'.replace(/.*/, '[credentials]@')).slice(0, 500);
}

/**
 * @typedef {object} FetchOpts
 * @property {number} [maxBytes]
 * @property {number} [timeoutMs]
 * @property {Record<string,string>} [headers]
 * @property {string|null} [proxyUrl]  residential proxy URL (with credentials) or null for direct
 */

/**
 * @param {string} url @param {FetchOpts} [opts]
 * @returns {Promise<{status:number, headers: Record<string,string>, text:string, finalUrl:string, via:'direct'|'residential'}>}
 */
export async function fetchText(url, opts = {}) {
  const { maxBytes = 5 * 1024 * 1024, timeoutMs = 20_000, headers = {}, proxyUrl = null } = opts;
  policeUrl(url);
  if (proxyUrl) {
    const viaProxy = await fetchViaProxy(url, { maxBytes, timeoutMs, headers, proxyUrl });
    if (viaProxy) return viaProxy;
  }
  const g = await guarded();
  const r = await g.guardedFetch(url, {
    maxBytes,
    timeoutMs,
    maxRedirects: 5,
    allowHttp: false,
    headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT, ...headers },
  });
  return {
    status: r.status,
    headers: r.headers ?? {},
    text: r.buffer.length ? r.buffer.toString('utf8') : '',
    finalUrl: r.finalUrl,
    via: 'direct',
  };
}

/**
 * Conditional GET for feeds: sends the stored validators, returns the new
 * ones. A 304 has status 304 and empty text. Same guard as fetchText.
 */
export async function fetchFeedConditional(url, { etag, lastModified, maxBytes = 5 * 1024 * 1024, timeoutMs = 20_000, proxyUrl = null } = {}) {
  const cond = {};
  if (etag && /^[\x21-\x7e ]{1,256}$/.test(etag)) cond['If-None-Match'] = etag;
  if (lastModified && /^[\x20-\x7e]{1,64}$/.test(lastModified)) cond['If-Modified-Since'] = lastModified;
  const r = await fetchText(url, { maxBytes, timeoutMs, headers: cond, proxyUrl });
  return { ...r, etag: r.headers.etag ?? null, lastModified: r.headers['last-modified'] ?? null };
}

let _undici = null;
async function undici() {
  if (_undici !== null) return _undici || null;
  try {
    _undici = await import('undici');
  } catch {
    _undici = false;
    console.warn('[content-sources] undici is not installed on this worker; residential egress unavailable, fetching direct');
  }
  return _undici || null;
}

async function fetchViaProxy(url, { maxBytes, timeoutMs, headers, proxyUrl }) {
  const u = await undici();
  if (!u) return null;
  const dispatcher = new u.ProxyAgent(proxyUrl);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      policeUrl(current);
      const res = await u.fetch(current, {
        dispatcher,
        redirect: 'manual',
        signal: ctl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT, ...headers },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc || hop === 5) return { status: res.status, headers: headerMap(res.headers), text: '', finalUrl: current, via: 'residential' };
        current = new URL(loc, current).toString();
        continue;
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new FetchRefusedError(`response exceeds ${maxBytes} bytes`);
      if (!res.ok) return { status: res.status, headers: headerMap(res.headers), text: '', finalUrl: current, via: 'residential' };
      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new FetchRefusedError(`response exceeds ${maxBytes} bytes`);
        chunks.push(chunk);
      }
      return { status: res.status, headers: headerMap(res.headers), text: Buffer.concat(chunks, total).toString('utf8'), finalUrl: current, via: 'residential' };
    }
    throw new FetchRefusedError('too many redirects');
  } catch (e) {
    // Never let the proxy URL (credentials) travel in an error message.
    if (e && typeof e.message === 'string') e.message = scrubSecrets(e.message, proxyUrl);
    throw e;
  } finally {
    clearTimeout(timer);
    dispatcher.close?.().catch?.(() => {});
  }
}

function headerMap(h) {
  const out = {};
  for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Resolve the residential proxy URL for this run, or null when the module
 * is not installed/configured. Never throws, never logs the URL.
 */
export async function residentialProxyUrl(supabase) {
  try {
    const egress = await import(path.join(EGRESS_LIB, 'egress.ts'));
    const resolved = await egress.resolveEgress(supabase);
    if (!resolved.configured || !resolved.creds) return null;
    return egress.freshProxyUrl(resolved.creds)?.proxyUrl ?? null;
  } catch (e) {
    console.warn(`[content-sources] residential-egress unavailable: ${scrubSecrets(e?.message ?? e)}`);
    return null;
  }
}
