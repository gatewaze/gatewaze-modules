/**
 * The podcast feed: where the episode list comes from.
 *
 * This is the ONLY route to the episode catalogue that is unambiguously
 * clean. An RSS feed is published for machines to read — it is the entire
 * point of the format — whereas Spotify's creator dashboard is
 * `Disallow: /` in robots.txt and its User Guidelines prohibit automated
 * access with no carve-out for your own data. So the catalogue comes from
 * here and the numbers come from OP3 or a human CSV export, and nothing in
 * this module ever holds a Spotify session cookie.
 *
 * Parsed without an XML library on purpose. The worker image bakes module
 * npm deps at BUILD time, so adding fast-xml-parser would leave discovery
 * broken until the next release — a trap this codebase has hit before. A
 * podcast feed is a narrow, stable format, so a targeted extractor for the
 * dozen tags we need is the smaller risk. It is deliberately strict: an item
 * that does not yield a guid and a title is skipped and counted, never
 * guessed at.
 *
 * Verified against the real AAIF feed on 2026-10-11:
 * anchor.fm/s/174cb1b8/podcast/rss — 555 episodes, 555 distinct guids,
 * guid isPermaLink="false", duration as HH:MM:SS.
 */

export interface FeedEpisode {
  /** The <guid>. Stable across edits and the natural idempotency key. */
  guid: string;
  title: string;
  description: string;
  /** ISO 8601, or null when pubDate was absent or unparseable. */
  publishedAt: string | null;
  /** The episode page on the host, not the audio. */
  link: string | null;
  audioUrl: string | null;
  durationSeconds: number | null;
  imageUrl: string | null;
  episodeNumber: number | null;
}

export interface ParsedFeed {
  title: string;
  description: string;
  imageUrl: string | null;
  episodes: FeedEpisode[];
  /** Items that could not be read. Reported, never silently dropped. */
  skipped: number;
}

/** Strip CDATA and decode the five XML entities. Nothing else. */
export function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Numeric entities before the bare ampersand, or &#38; becomes & and then
    // nothing decodes the rest.
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

/** The text of the first <tag> in a fragment, or null. */
export function tagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? decodeXmlText(m[1]) : null;
}

/** An attribute of the first <tag ...>, or null. */
export function tagAttr(xml: string, tag: string, attr: string): string | null {
  const open = new RegExp(`<${tag}(\\s[^>]*)/?>`, 'i').exec(xml);
  if (!open) return null;
  const m = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i').exec(open[1]);
  return m ? decodeXmlText(m[1]) : null;
}

/**
 * iTunes duration, which comes in three shapes in the wild: seconds,
 * MM:SS, or HH:MM:SS. The AAIF feed uses the third.
 */
export function parseDuration(value: string | null): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const parts = v.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/** RFC 822 pubDate to ISO, or null rather than an invented date. */
export function parsePubDate(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function parseFeed(xml: string): ParsedFeed {
  const channelStart = xml.indexOf('<channel');
  const head = channelStart >= 0 ? xml.slice(channelStart, xml.indexOf('<item', channelStart)) : xml.slice(0, 4000);

  const episodes: FeedEpisode[] = [];
  let skipped = 0;

  // Split on the item boundary rather than matching a greedy pattern over
  // 5.8MB: a single backtracking regex across a feed this size is how a
  // parser becomes a hang.
  const parts = xml.split(/<item(?:\s[^>]*)?>/i).slice(1);
  for (const part of parts) {
    const end = part.search(/<\/item\s*>/i);
    const item = end >= 0 ? part.slice(0, end) : part;

    const guid = tagText(item, 'guid');
    const title = tagText(item, 'title');
    if (!guid || !title) { skipped += 1; continue; }

    const epNo = tagText(item, 'itunes:episode');
    episodes.push({
      guid,
      title,
      description: tagText(item, 'description') ?? tagText(item, 'itunes:summary') ?? '',
      publishedAt: parsePubDate(tagText(item, 'pubDate')),
      link: tagText(item, 'link'),
      audioUrl: tagAttr(item, 'enclosure', 'url'),
      durationSeconds: parseDuration(tagText(item, 'itunes:duration')),
      imageUrl: tagAttr(item, 'itunes:image', 'href'),
      episodeNumber: epNo && /^\d+$/.test(epNo) ? Number(epNo) : null,
    });
  }

  return {
    title: tagText(head, 'title') ?? '',
    description: tagText(head, 'description') ?? '',
    imageUrl: tagAttr(head, 'itunes:image', 'href'),
    episodes,
    skipped,
  };
}

/**
 * Fetch and parse, with the limits every outbound call in this codebase has.
 *
 * 10MB because the real feed is 5.8MB and grows with every episode; a feed
 * that has doubled is a reason to look rather than to keep streaming.
 */
export async function fetchFeed(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ ok: boolean; status: number; feed?: ParsedFeed; error?: string }> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000);
  try {
    let u: URL;
    try { u = new URL(url); } catch { return { ok: false, status: 0, error: 'not a URL' }; }
    if (u.protocol !== 'https:') return { ok: false, status: 0, error: 'feed URL must be https' };

    const res = await fetch(u.toString(), {
      headers: { 'User-Agent': 'Gatewaze/1 (+https://gatewaze.org)' },
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: `feed returned ${res.status}` };

    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) return { ok: false, status: res.status, error: `feed exceeds ${maxBytes} bytes` };

    const text = await res.text();
    if (text.length > maxBytes) return { ok: false, status: res.status, error: `feed exceeds ${maxBytes} bytes` };

    return { ok: true, status: res.status, feed: parseFeed(text) };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
