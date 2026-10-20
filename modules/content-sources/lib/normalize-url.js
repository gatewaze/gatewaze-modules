/**
 * URL normalisation for discovery sources and discovered posts.
 *
 * This is the JavaScript twin of the SQL function `discovery_normalize_url`
 * (migrations/001). The two MUST agree: the database uses the SQL form for
 * the unique indexes and the scraper uses this form to look rows up before it
 * writes. The unit test in __tests__/normalize-url.test.js pins the shared
 * cases; if you change one, change the other and the test.
 *
 * Rules: drop the scheme (http and https are one key), lowercase the host,
 * strip a leading `www.`, drop the fragment, drop a trailing slash on the
 * path (and the path entirely when it is just `/`), drop tracking params
 * (utm_*, fbclid, gclid, ref, source), sort the params that remain. Anything
 * that is not URL-shaped comes back lowercased and trimmed rather than
 * throwing, so one bad link cannot abort a batch.
 */

const TRACKING = /^(utm_[^=]*|fbclid|gclid|ref|source)(=|$)/i;

/** @param {string} raw @returns {string} */
export function normalizeUrl(raw) {
  let u = String(raw ?? '').trim();
  if (!u) return '';
  u = u.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  u = u.replace(/#.*$/, '');
  const hostMatch = u.match(/^([^/?]+)/);
  if (!hostMatch) return u.toLowerCase();
  const host = hostMatch[1].toLowerCase().replace(/^www\./, '');
  const rest = u.slice(hostMatch[1].length);
  const qIdx = rest.indexOf('?');
  let path = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  const query = qIdx >= 0 ? rest.slice(qIdx + 1) : '';
  path = path === '' || path === '/' ? '' : path.replace(/\/+$/, '');
  const params = query
    .split('&')
    .filter((p) => p !== '' && !TRACKING.test(p))
    .sort();
  return host + path + (params.length ? '?' + params.join('&') : '');
}

/**
 * The URL we store: https, no fragment, tracking params removed, original
 * host casing and path otherwise preserved. Returns null when the input is
 * not an http(s) URL.
 * @param {string} raw @returns {string|null}
 */
export function canonicalForStorage(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  u.protocol = 'https:';
  u.hash = '';
  const keep = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING.test(`${k}=`)) keep.push([k, v]);
  }
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  return u.toString();
}

/** Lowercased host with any leading www. removed, or ''. @param {string} url */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Registrable domain, approximated: the last two labels, or three when the
 * second-to-last is a well-known second-level suffix (co.uk, com.au, ...).
 * Good enough to say whether blog.example.org belongs to example.org.
 * @param {string} host
 */
export function registrableDomain(host) {
  const parts = String(host ?? '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const twoLevel = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'or', 'ne']);
  if (twoLevel.has(sld) && tld.length === 2) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/** URL-safe slug from text. @param {string} s */
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Short stable hash (8 hex chars) of a string, FNV-1a 32-bit. @param {string} s */
export function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * blog_posts.slug for a discovered post: `<host-slug>--<path-slug>`. A URL
 * whose path is empty or numeric only (WordPress `?p=123`) uses a hash of the
 * normalised URL instead of the path, and a slug that had to be truncated gets
 * the hash appended so two long paths with a common prefix stay distinct.
 * @param {string} canonicalUrl @returns {string}
 */
export function slugForPost(canonicalUrl) {
  const norm = normalizeUrl(canonicalUrl);
  const host = slugify(hostOf(canonicalUrl) || norm.split(/[/?]/)[0]);
  let path = '';
  try {
    path = new URL(canonicalUrl).pathname;
  } catch {
    path = '';
  }
  const pathSlug = slugify(path.replace(/\.(html?|php|aspx?)$/i, ''));
  const hash = shortHash(norm);
  if (!pathSlug || /^[0-9-]+$/.test(pathSlug)) return `${host}--${hash}`;
  let slug = `${host}--${pathSlug}`;
  if (slug.length > 480) slug = `${slug.slice(0, 480).replace(/-+$/, '')}-${hash}`;
  return slug;
}
