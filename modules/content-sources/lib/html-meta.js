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

/** Remove <nav>, <aside>, <header>, <footer>, <form>, <script>, <style>, <noscript>, <svg>, <button> regions (non-nested, linear). */
function stripChrome(s) {
  const names = ['nav', 'aside', 'header', 'footer', 'form', 'script', 'style', 'noscript', 'svg', 'button'];
  let out = s;
  for (const name of names) {
    let guard = 0;
    for (;;) {
      if (guard++ > 500) break;
      const r = region(out, new RegExp(`<${name}(?=[\\s>])`, 'ig'), new RegExp(`</${name}\\s*>`, 'ig'));
      if (!r) break;
      out = out.replace(r.outer, ' ');
    }
  }
  return out;
}

/**
 * The article body as raw HTML: the `entry-content` region (WordPress), a
 * `w-richtext` region (Webflow), the largest <article>, then <main> minus
 * its own chrome (Hugo, Docusaurus, HubSpot), then a few well-known content
 * classes. null when nothing plausible is found (we do not want page chrome).
 */
export function articleBody(html) {
  const s = String(html ?? '');
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
  if (best && stripHtml(best).length > 120) return best;
  const main = region(s, /<main(?=[\s>])/ig, /<\/main\s*>/ig);
  if (main) {
    const inner = stripChrome(main.inner);
    if (stripHtml(inner).length > 120) return inner;
  }
  for (const cls of ['post-content', 'post-body', 'article-content', 'article-body', 'blog-post-content', 'content-body', 'td-content', 'markdown']) {
    const r = region(s, new RegExp(`<div(?=[\\s>])[^<>]*\\bclass\\s*=\\s*["'][^"'<>]*\\b${cls}\\b`, 'ig'), /<\/(?:main|section|article)\s*>|<footer(?=[\s>])|<aside(?=[\s>])/gi);
    if (r && stripHtml(r.inner).length > 120) return r.inner;
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
 * Caps the result at `maxChars`.
 */
export async function sanitizeBody(html, maxChars = 60_000) {
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
    const out = sanitizeHtml(String(html), {
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
    }).trim();
    return out.length > maxChars ? out.slice(0, maxChars) : out;
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
