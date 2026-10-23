/**
 * Read what we need out of an article's HTML without a DOM library: feed
 * alternates, publish dates, og:title / og:description, rel=canonical, and
 * the article body region.
 *
 * Every scan is linear in the input (see feed-parser.js for why): regions
 * are found with indexOf / one forward regex exec, character classes
 * exclude '<', and the head is capped at 200 KB regardless of where
 * </head> is. Everything returned is untrusted text to the caller.
 */

import { decodeEntities, stripHtml, attrsOf } from './feed-parser.js';
import { policeUrl } from './http.js';

const HEAD_CAP = 200 * 1024;

/** The <head> region (or the first 200 KB), scanned once per page. */
function headOf(html) {
  const s = String(html ?? '');
  const headEnd = s.indexOf('</head');
  return s.slice(0, Math.min(headEnd > 0 ? headEnd : HEAD_CAP, HEAD_CAP));
}

/** Every <meta ...> and <link ...> open tag in the head, as attribute maps, computed once. */
export function headTags(html) {
  const out = [];
  const re = /<(meta|link)(?=[\s/>])([^<>]*)>/gi;
  let m;
  const head = headOf(html);
  while ((m = re.exec(head)) !== null) out.push({ tag: m[1].toLowerCase(), attrs: attrsOf(m[2] || '') });
  return out;
}

/** `<link rel="alternate" type="application/rss+xml|atom+xml">` hrefs, absolute. */
export function feedAlternates(html, baseUrl, tags = headTags(html)) {
  const out = [];
  for (const { tag, attrs } of tags) {
    if (tag !== 'link') continue;
    const rel = (attrs.rel ?? '').toLowerCase();
    const type = (attrs.type ?? '').toLowerCase();
    if (!rel.split(/\s+/).includes('alternate')) continue;
    if (!/application\/(rss|atom|rdf)\+xml/.test(type)) continue;
    if (!attrs.href) continue;
    try {
      out.push({ href: new URL(attrs.href, baseUrl).toString(), title: attrs.title ?? null, type });
    } catch {
      /* skip unparseable */
    }
  }
  return out;
}

function metaContent(tags, key) {
  const k = key.toLowerCase();
  for (const { tag, attrs } of tags) {
    if (tag !== 'meta') continue;
    const prop = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase();
    if (prop !== k) continue;
    const c = attrs.content;
    if (c && c.trim()) return c.trim();
  }
  return null;
}

/** og:title or <title>, as text. */
export function pageTitle(html, tags = headTags(html)) {
  const og = metaContent(tags, 'og:title');
  if (og) return stripHtml(og);
  const head = headOf(html);
  const i = head.search(/<title(?=[\s>])/i);
  if (i < 0) return null;
  const gt = head.indexOf('>', i);
  const end = head.indexOf('</title', gt);
  if (gt < 0 || end < 0) return null;
  return stripHtml(head.slice(gt + 1, end));
}

/** og:description, else meta description, else null. Short strings (< 30 chars) are ignored like the harvest did. */
export function pageDescription(html, tags = headTags(html)) {
  for (const key of ['og:description', 'description', 'twitter:description']) {
    const v = metaContent(tags, key);
    if (v && v.length > 30) return stripHtml(v);
  }
  return null;
}

/** rel=canonical href, absolute, or null. */
export function canonicalLink(html, baseUrl, tags = headTags(html)) {
  for (const { tag, attrs } of tags) {
    if (tag !== 'link') continue;
    if ((attrs.rel ?? '').toLowerCase() !== 'canonical' || !attrs.href) continue;
    try {
      return new URL(attrs.href, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

/**
 * The page's own publish date as ISO, or null. Order, as in scrapers.py:
 * article:published_time and friends, <time datetime>, JSON-LD datePublished,
 * then a visible long-form date as a last resort.
 */
export function publishedDate(html, tags = headTags(html)) {
  for (const key of ['article:published_time', 'og:article:published_time', 'datepublished', 'date', 'dc.date', 'article:modified_time']) {
    const v = metaContent(tags, key);
    const t = v ? Date.parse(v.slice(0, 64)) : NaN;
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const s = String(html ?? '');
  const time = /<time(?=[\s>])[^<>]*\sdatetime\s*=\s*["']([^"'<>]{1,64})["']/i.exec(s);
  if (time) {
    const t = Date.parse(time[1]);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const ld = /"datePublished"\s*:\s*"([^"]{1,64})"/.exec(s);
  if (ld) {
    const t = Date.parse(ld[1]);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const vis = new RegExp(`(${MONTHS})\\s+(\\d{1,2}),?\\s+(20\\d\\d)`).exec(stripHtml(s.slice(0, 60_000)));
  if (vis) {
    const t = Date.parse(`${vis[1]} ${vis[2]} ${vis[3]} UTC`);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/**
 * The region from the first match of `openRe` to the first match of
 * `closeRe` after it, as one forward scan each. Returns null when either
 * side is missing. `openRe` and `closeRe` must be global regexes.
 */
function region(s, openRe, closeRe) {
  openRe.lastIndex = 0;
  const o = openRe.exec(s);
  if (!o) return null;
  const gt = s.indexOf('>', o.index);
  if (gt < 0) return null;
  closeRe.lastIndex = gt + 1;
  const c = closeRe.exec(s);
  if (!c) return null;
  return { inner: s.slice(gt + 1, c.index), outer: s.slice(o.index, c.index + c[0].length) };
}

/**
 * Remove <nav>, <aside>, <header>, <footer>, <form>, <script>, <style>,
 * <noscript>, <svg>, <button> regions (non-nested). One forward pass per
 * name: each region is skipped as the scan passes it, so a page with
 * thousands of them costs the same as a page with one.
 */
function stripChrome(s) {
  const names = ['nav', 'aside', 'header', 'footer', 'form', 'script', 'style', 'noscript', 'svg', 'button'];
  let out = s;
  for (const name of names) {
    const openRe = new RegExp(`<${name}(?=[\\s>])`, 'ig');
    const closeRe = new RegExp(`</${name}\\s*>`, 'ig');
    let kept = '';
    let i = 0;
    for (;;) {
      openRe.lastIndex = i;
      const o = openRe.exec(out);
      if (!o) break;
      const gt = out.indexOf('>', o.index);
      if (gt < 0) break;
      closeRe.lastIndex = gt + 1;
      const c = closeRe.exec(out);
      if (!c) break;
      kept += out.slice(i, o.index) + ' ';
      i = c.index + c[0].length;
    }
    out = kept + out.slice(i);
  }
  return out;
}

/**
 * The inner HTML of the element whose open tag starts at `openIdx`, matched
 * to ITS close tag by counting nested same-name tags in one forward scan
 * (so a <span> body full of <span>s, or a <section> holding sections, is
 * taken whole). Linear: one global regex walks forward once. null when the
 * element never closes.
 */
function balanced(s, openIdx, name) {
  const gt = s.indexOf('>', openIdx);
  if (gt < 0) return null;
  if (s[gt - 1] === '/') return null; // self-closing: no body
  const re = new RegExp(`<(/?)${name}(?=[\\s>/])`, 'ig');
  re.lastIndex = gt + 1;
  let depth = 1;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) {
      depth -= 1;
      if (depth === 0) return s.slice(gt + 1, m.index);
    } else {
      depth += 1;
    }
  }
  return null;
}

/**
 * Known post-body containers, tried in order before anything generic. Each
 * is an element (tag names, then an id or class token) taken whole with
 * `balanced`. Only the FIRST opener of each is used, so a page of 100k
 * fake openers costs one scan, not one per opener.
 *   - HubSpot CMS (linuxfoundation.org, finos.org): the post body is
 *     `<span id="hs_cos_wrapper_post_body" class="hs_cos_wrapper ...">`.
 *   - Google Developers Blog: `<section class="blocks-container ...">`
 *     holds the rich-text, code and image blocks; the summary, author,
 *     tags and related-posts sections are its siblings, not its children.
 *   - `<div class="article-content">` (blog.cloudflare.com and others):
 *     taken whole, so the post's tag list and the newsletter box around it
 *     stay out.
 */
const BODY_CONTAINERS = [
  { tags: ['span', 'div'], attr: 'id', token: 'hs_cos_wrapper_post_body' },
  { tags: ['span', 'div'], attr: 'class', token: 'hs_cos_wrapper_post_body' },
  { tags: ['section', 'div'], attr: 'class', token: 'blocks-container' },
  { tags: ['div'], attr: 'class', token: 'article-content' },
];

function knownContainer(s) {
  for (const { tags, attr, token } of BODY_CONTAINERS) {
    const re = new RegExp(`<(${tags.join('|')})(?=[\\s>])[^<>]*\\b${attr}\\s*=\\s*["'][^"'<>]*\\b${token}\\b`, 'i');
    const m = re.exec(s);
    if (!m) continue;
    const inner = balanced(s, m.index, m[1].toLowerCase());
    if (inner != null && stripHtml(inner).length > 120) return inner;
  }
  return null;
}

/**
 * The share of the page's readable text an <article> must hold before we
 * believe it is the post. On linuxfoundation.org the largest <article> is a
 * ~126-character related-post card while the post itself sits elsewhere.
 */
const ARTICLE_MIN_SHARE = 0.3;

/**
 * The article body as raw HTML: a known post-body container (HubSpot,
 * Google Developers), the `entry-content` region (WordPress), a
 * `w-richtext` region (Webflow), the largest <article> when it holds a
 * real share of the page's text, then <main> minus its own chrome (Hugo,
 * Docusaurus), then a few well-known content classes. null when nothing
 * plausible is found (we do not want page chrome).
 */
export function articleBody(html) {
  const s = String(html ?? '');
  const known = knownContainer(s);
  if (known) return known;
  for (const cls of ['entry-content', 'w-richtext']) {
    const r = region(s, new RegExp(`<div(?=[\\s>])[^<>]*\\bclass\\s*=\\s*["'][^"'<>]*\\b${cls}\\b`, 'ig'), /<\/(?:article|main|section)\s*>|<footer(?=[\s>])|<aside(?=[\s>])|<div(?=[\s>])[^<>]*\bclass\s*=\s*["'][^"'<>]*\b(?:post-navigation|elementor-location-footer|lf-footer)\b/gi);
    if (r && stripHtml(r.inner).length > 120) return r.inner;
  }
  // Largest <article>: linear scan over article open/close pairs.
  let best = '';
  let from = 0;
  for (let guard = 0; guard < 200; guard++) {
    const rest = s.slice(from);
    const r = region(rest, /<article(?=[\s>])/ig, /<\/article\s*>/ig);
    if (!r) break;
    if (r.outer.length > best.length) best = r.outer;
    from += rest.indexOf(r.outer) + r.outer.length;
  }
  const main = region(s, /<main(?=[\s>])/ig, /<\/main\s*>/ig);
  const mainInner = main ? stripChrome(main.inner) : null;
  if (best) {
    const bestText = stripHtml(best).length;
    if (bestText > 120) {
      // Compare against the page's readable text: <main> minus chrome when
      // there is one, else the whole <body> minus chrome.
      const bodyOpen = s.search(/<body(?=[\s>])/i);
      const ref = mainInner ?? stripChrome(bodyOpen >= 0 ? s.slice(bodyOpen) : s);
      const refText = stripHtml(ref).length;
      if (refText === 0 || bestText >= ARTICLE_MIN_SHARE * refText) return best;
    }
  }
  if (mainInner != null && stripHtml(mainInner).length > 120) return mainInner;
  for (const cls of ['post-content', 'post-body', 'article-content', 'article-body', 'blog-post-content', 'content-body', 'td-content', 'markdown']) {
    const r = region(s, new RegExp(`<div(?=[\\s>])[^<>]*\\bclass\\s*=\\s*["'][^"'<>]*\\b${cls}\\b`, 'ig'), /<\/(?:main|section|article)\s*>|<footer(?=[\s>])|<aside(?=[\s>])/gi);
    if (r && stripHtml(r.inner).length > 120) return r.inner;
  }
  return null;
}

/**
 * Block-level closers a truncated body may end on. Cutting just after one
 * of these never splits a paragraph, a code block, a list item or a heading.
 */
const BLOCK_CLOSERS = ['</p>', '</pre>', '</li>', '</h1>', '</h2>', '</h3>', '</h4>', '</h5>', '</h6>', '</blockquote>', '</figure>', '</table>'];

/**
 * The longest prefix of `html` no longer than `maxChars` that ends just
 * after a block closer (else after the last '>', else a plain cut). The
 * caller re-sanitises the result so any element left open (a <ul>, a
 * <div>) is closed and the stored HTML is well-formed. Linear: one
 * lastIndexOf per closer over the prefix.
 */
export function truncateAtBlock(html, maxChars) {
  const s = String(html ?? '');
  if (s.length <= maxChars) return s;
  const head = s.slice(0, maxChars).toLowerCase();
  let cut = -1;
  for (const closer of BLOCK_CLOSERS) {
    const i = head.lastIndexOf(closer);
    if (i >= 0 && i + closer.length > cut) cut = i + closer.length;
  }
  if (cut <= 0) {
    const gt = head.lastIndexOf('>');
    cut = gt >= 0 ? gt + 1 : maxChars;
  }
  return s.slice(0, cut);
}

/** The stored-body cap. Long engineering posts (Cloudflare, Node.js, Ceph) run past 60 KB of sanitised HTML. */
export const BODY_MAX_CHARS = 200_000;

/** The longest image URL we store; matches policeUrl's URL cap. */
const IMAGE_URL_MAX = 2048;

/**
 * An image URL safe to store for display: absolute (resolved against
 * `baseUrl` when relative), https only, no credentials, no IP-literal or
 * internal-looking host, at most 2048 characters. We never fetch it; the
 * admin and portal render it in an <img>. null when it does not pass.
 */
export function imageUrlForStorage(raw, baseUrl) {
  const v = String(raw ?? '').trim();
  if (!v || v.length > IMAGE_URL_MAX) return null;
  let u;
  try {
    u = new URL(v, baseUrl || undefined);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  try {
    const out = policeUrl(u.toString()).toString();
    return out.length <= IMAGE_URL_MAX ? out : null;
  } catch {
    return null;
  }
}

/** og:image (or its secure_url), else twitter:image, as a storable https URL, or null. */
export function pageImage(html, baseUrl, tags = headTags(html)) {
  for (const key of ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']) {
    const v = imageUrlForStorage(metaContent(tags, key), baseUrl);
    if (v) return v;
  }
  return null;
}

/**
 * Allow-list sanitiser for stored bodies. REQUIRES `sanitize-html` (declared
 * in this module's package.json and baked into the worker image). When it
 * cannot be loaded it FAILS CLOSED and returns null (caller: leave the body
 * NULL and do not count an attempt, so a worker that has the dependency
 * picks it up); when it throws on the input it returns ''. The earlier
 * regex fallback was bypassable (unquoted on* attributes, entity-encoded
 * schemes) and the body is rendered on the portal once approved.
 * Caps the result at `maxChars` (default BODY_MAX_CHARS): a longer body is
 * cut at a block boundary (see truncateAtBlock) and sanitised again, which
 * closes anything the cut left open.
 */
export async function sanitizeBody(html, maxChars = BODY_MAX_CHARS) {
  if (!html) return '';
  let sanitizeHtml;
  try {
    const mod = await import('sanitize-html');
    sanitizeHtml = mod.default || mod;
  } catch (e) {
    console.warn(`[content-sources] sanitize-html is not installed on this worker (${e?.message ?? e}); bodies are left for a worker that has it`);
    return null;
  }
  try {
    const options = {
      allowedTags: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div'],
      allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt'], '*': [] },
      allowedSchemes: ['http', 'https', 'mailto'],
      allowedSchemesByTag: { img: ['https'] },
      allowProtocolRelative: false,
      transformTags: { a: (tagName, attribs) => ({ tagName: 'a', attribs: { ...attribs, rel: 'noopener nofollow', target: '_blank' } }) },
      // sanitize-html lets RELATIVE urls through regardless of allowedSchemes;
      // a relative image src would resolve against our own portal host, so an
      // image survives only with an absolute https source.
      exclusiveFilter: (frame) => frame.tag === 'img' && !/^https:\/\//i.test(String(frame.attribs?.src ?? '')),
    };
    let out = sanitizeHtml(String(html), options).trim();
    // Cut at a block boundary, re-sanitise to close what the cut left open,
    // and step the limit down if the closing tags pushed it back over.
    for (let limit = maxChars, tries = 0; out.length > maxChars && tries < 5; tries++, limit -= 1000) {
      out = sanitizeHtml(truncateAtBlock(out, Math.max(limit, 1)), options).trim();
    }
    // Never hand back a hard slice: it could end inside a tag the portal
    // then renders. A body that still will not fit is treated as unusable.
    return out.length > maxChars ? '' : out;
  } catch (e) {
    console.warn(`[content-sources] sanitize-html failed on a body (${e?.message ?? e}); body not stored`);
    return '';
  }
}

/**
 * Sitemap <url> entries: { loc, lastmod } with lastmod as ISO or null.
 * Sitemap indexes (<sitemapindex>) return their child sitemap locs with
 * `isIndex: true` so the caller can follow one level. Linear.
 */
export function parseSitemap(xml) {
  const doc = String(xml ?? '');
  const isIndex = /<sitemapindex[\s>]/i.test(doc.slice(0, 2000));
  const out = [];
  const re = isIndex
    ? /<sitemap>\s*<loc>([^<>]{1,2048})<\/loc>(?:\s*<lastmod>([^<>]{1,64})<\/lastmod>)?/gi
    : /<url>\s*<loc>([^<>]{1,2048})<\/loc>(?:\s*<lastmod>([^<>]{1,64})<\/lastmod>)?/gi;
  let m;
  while ((m = re.exec(doc)) !== null && out.length < 50_000) {
    const loc = decodeEntities(m[1]).trim();
    const t = m[2] ? Date.parse(m[2].trim()) : NaN;
    out.push({ loc, lastmod: Number.isFinite(t) ? new Date(t).toISOString() : null });
  }
  return { isIndex, entries: out };
}
