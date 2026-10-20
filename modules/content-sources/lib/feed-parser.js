/**
 * RSS 2.0, Atom and RDF/RSS 1.0 feed parsing without an XML library.
 *
 * Why no library: the worker image bakes module npm deps at BUILD time, so a
 * parser added here would leave the scraper broken on every worker until the
 * next release (videos-publisher-spotify/lib/rss.ts documents the same trap).
 * A feed is a narrow, stable format, and we only need a dozen tags. The
 * extractor is deliberately strict: an entry without a title and a link is
 * skipped and counted, never guessed at.
 *
 * Security: this parses bytes from any host an operator points us at, and
 * it runs inside the API process (resolve) as well as the worker, so every
 * scan here is LINEAR in the input. No `[^>]*` or lazy `[\s\S]*?` across
 * attacker-chosen distances: those are O(n²) when the closer never comes
 * (300k unclosed <title> tags stalled the event loop for minutes in the
 * review's benchmark). Tag bodies are found with one forward scan each, and
 * character classes exclude '<' so an unclosed tag ends at the next one.
 * There is no DTD processing and no entity expansion beyond the five XML
 * entities and numeric references, and entities are decoded exactly ONCE,
 * after tags are stripped, so a decoded '<' can never become a tag.
 */

/** Hard cap on any text handed to a regex here (per field, per document). */
export const MAX_FIELD_CHARS = 256 * 1024;

const clip = (s) => (s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s);

function safeCodePoint(n, orig) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return orig;
  try {
    return String.fromCodePoint(n);
  } catch {
    return orig;
  }
}

/** Remove <![CDATA[ ... ]]> wrappers (keeping their text) with a linear scan. */
export function stripCdata(raw) {
  const s = String(raw ?? '');
  if (!s.includes('<![CDATA[')) return s;
  let out = '';
  let i = 0;
  for (;;) {
    const start = s.indexOf('<![CDATA[', i);
    if (start < 0) { out += s.slice(i); break; }
    out += s.slice(i, start);
    const end = s.indexOf(']]>', start + 9);
    if (end < 0) { out += s.slice(start + 9); break; } // unterminated: take the rest as text
    out += s.slice(start + 9, end);
    i = end + 3;
  }
  return out;
}

/** Decode the five XML entities and numeric references. ONE pass; never call twice on the same text. */
export function decodeEntities(raw) {
  return String(raw ?? '')
    .replace(/&#(\d{1,8});/g, (m, n) => safeCodePoint(Number(n), m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => safeCodePoint(parseInt(n, 16), m))
    .replace(/&(lt|gt|quot|apos|amp|nbsp);/g, (m, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' })[e] ?? m);
}

/** Tags out (an unclosed tag ends at the next '<'), then one entity decode, then whitespace collapsed. Always text. */
export function stripHtml(raw) {
  let s = stripCdata(clip(String(raw ?? '')));
  s = s.replace(/<[^<>]*>/g, ' ');
  s = decodeEntities(s);
  // A decode can produce '<...>' from '&lt;b&gt;'; that is text, but drop it
  // rather than let it travel into a field something may render.
  s = s.replace(/<[^<>]*>/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Back-compat name used by html-meta.js: CDATA + entities, no tag stripping. */
export function decodeXmlText(raw) {
  return decodeEntities(stripCdata(String(raw ?? ''))).trim();
}

/**
 * The raw inner text of the first <tag> (any namespace prefix allowed, or a
 * specific one), found with ONE forward scan: locate the open tag, its '>',
 * then the first matching close tag. Returns null when absent or unclosed.
 */
export function tagRaw(xml, tag, prefix = null) {
  const s = String(xml ?? '');
  const pfx = prefix ? `${prefix}:` : '(?:[a-z0-9]+:)?';
  const open = new RegExp(`<${pfx}${tag}(?=[\\s>/])`, 'ig');
  const m = open.exec(s);
  if (!m) return null;
  const gt = s.indexOf('>', m.index);
  if (gt < 0) return null;
  if (s[gt - 1] === '/') return ''; // self-closing
  const close = new RegExp(`</${pfx}${tag}\\s*>`, 'ig');
  close.lastIndex = gt + 1;
  const c = close.exec(s);
  if (!c) return null;
  return s.slice(gt + 1, c.index);
}

/** Text of the first <tag>: tags stripped, entities decoded once. */
export function tagText(xml, tag) {
  const raw = tagRaw(xml, tag);
  return raw == null ? null : stripHtml(raw);
}

function nsTagText(xml, prefix, tag) {
  const raw = tagRaw(xml, tag, prefix);
  return raw == null ? null : stripHtml(raw);
}

/** Attributes of one open tag string like `<link rel="x" href="y">`. */
export function attrsOf(openTag) {
  const attrs = {};
  const a = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'<>]+))/g;
  let am;
  while ((am = a.exec(openTag)) !== null) attrs[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? '');
  return attrs;
}

/** All <link ...> open tags in a fragment as attribute maps (linear: the body class excludes '<'). */
function linkTags(xml) {
  const out = [];
  const re = /<(?:[a-z0-9]+:)?link(?=[\s/>])([^<>]*)>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(attrsOf(m[1] || ''));
  return out;
}

/** RFC 822 / ISO 8601 → ISO string, or null rather than an invented date. */
export function parseDate(value) {
  if (!value) return null;
  const t = Date.parse(String(value).trim().slice(0, 64));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function absolute(href, base) {
  if (!href) return null;
  try {
    return new URL(href.trim(), base || undefined).toString();
  } catch {
    return null;
  }
}

/**
 * @typedef {object} FeedEntry
 * @property {string} title
 * @property {string} link
 * @property {string|null} guid
 * @property {string|null} publishedAt
 * @property {string|null} updatedAt
 * @property {string} summary  plain text, untruncated
 */

/**
 * Parse a feed document. `baseUrl` resolves relative links.
 * @param {string} xml @param {string} [baseUrl]
 */
export function parseFeed(xml, baseUrl) {
  const doc = String(xml ?? '');
  const head = doc.slice(0, 4000);
  let kind = 'unknown';
  if (/<feed[\s>]/i.test(head)) kind = 'atom';
  else if (/<rdf:RDF[\s>]/i.test(head)) kind = 'rdf';
  else if (/<rss[\s>]/i.test(head) || /<channel[\s>]/i.test(head)) kind = 'rss';
  if (kind === 'unknown') return { kind, title: '', siteUrl: null, entries: [], skipped: 0 };

  const itemTag = kind === 'atom' ? 'entry' : 'item';
  // Split on the item boundary (one linear pass) rather than matching a
  // greedy pattern over the whole document.
  const splitRe = new RegExp(`<(?:[a-z0-9]+:)?${itemTag}(?=[\\s>])[^<>]*>`, 'i');
  const parts = doc.split(splitRe);
  const channel = clip(parts[0]);

  const feedTitle = tagText(channel, 'title') ?? '';
  let siteUrl = null;
  if (kind === 'atom') {
    const alt = linkTags(channel).find((l) => (l.rel ?? 'alternate') === 'alternate' && l.href);
    siteUrl = absolute(alt?.href, baseUrl);
  } else {
    siteUrl = absolute(tagText(channel, 'link'), baseUrl);
  }

  const entries = [];
  let skipped = 0;
  const endRe = new RegExp(`</(?:[a-z0-9]+:)?${itemTag}\\s*>`, 'i');
  for (const part of parts.slice(1)) {
    const end = part.search(endRe);
    const item = clip(end >= 0 ? part.slice(0, end) : part);
    const entry = parseEntry(item, kind, baseUrl);
    if (!entry) skipped += 1;
    else entries.push(entry);
  }
  return { kind, title: feedTitle, siteUrl, entries, skipped };
}

function parseEntry(item, kind, baseUrl) {
  const title = tagText(item, 'title') ?? '';
  let link = null;
  if (kind === 'atom') {
    const links = linkTags(item);
    const alt = links.find((l) => (l.rel ?? 'alternate') === 'alternate' && l.href) ?? links.find((l) => l.href);
    link = absolute(alt?.href, baseUrl);
  } else {
    link = absolute(tagText(item, 'link'), baseUrl);
    if (!link) {
      const g = tagText(item, 'guid');
      if (g && /^https?:\/\//i.test(g)) link = g;
    }
    if (!link && kind === 'rdf') {
      const about = /\srdf:about\s*=\s*"([^"<>]+)"/i.exec(item.slice(0, 2000));
      link = absolute(about?.[1], baseUrl);
    }
  }
  if (!title || !link || !/^https?:\/\//i.test(link)) return null;

  const guid = tagText(item, kind === 'atom' ? 'id' : 'guid');
  const published = parseDate(tagText(item, 'published') ?? tagText(item, 'pubDate') ?? nsTagText(item, 'dc', 'date'));
  const updated = parseDate(tagText(item, 'updated') ?? nsTagText(item, 'atom', 'updated'));

  // feedparser's `summary` is <description> for RSS and <summary> for Atom;
  // the harvest read summary → content → description on top of that, so the
  // short field wins and the full body is the fallback.
  const summaryRaw =
    (kind === 'atom'
      ? tagRaw(item, 'summary') ?? tagRaw(item, 'content')
      : tagRaw(item, 'description') ?? tagRaw(item, 'summary') ?? tagRaw(item, 'encoded', 'content')) ?? '';
  return {
    title: title.slice(0, 1000),
    link,
    guid: guid ? guid.slice(0, 1000) : null,
    publishedAt: published,
    updatedAt: updated,
    summary: stripHtml(summaryRaw),
  };
}

/** True when the bytes look like a feed at all (cheap pre-check). */
export function looksLikeFeed(text) {
  const head = String(text ?? '').slice(0, 4000);
  return /<(rss|feed|rdf:RDF|channel)[\s>]/i.test(head);
}
