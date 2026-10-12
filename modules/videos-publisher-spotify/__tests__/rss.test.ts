/**
 * The podcast feed parser (lib/rss.ts).
 *
 * Parsed without an XML library, so these tests carry more weight than
 * usual: they are the only thing standing between a hand-rolled extractor
 * and 555 episodes of wrong data.
 *
 * The fixtures are the real shapes from the AAIF feed
 * (anchor.fm/s/174cb1b8/podcast/rss) as it was on 2026-10-11.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeXmlText,
  parseDuration,
  parseFeed,
  parsePubDate,
  tagAttr,
  tagText,
} from '../lib/rss';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title><![CDATA[Agentic Conversations (formally mlops.community)]]></title>
  <description><![CDATA[Talks &amp; interviews]]></description>
  <itunes:image href="https://cdn.test/cover.jpg"/>
  <item>
    <title><![CDATA[Inside a Game Where AI Agents Never Sleep]]></title>
    <description><![CDATA[What happens when half the players never log off?]]></description>
    <guid isPermaLink="false">5cbf4845-c44c-4cd5-a502-6b8b4faac06d</guid>
    <pubDate>Thu, 08 Oct 2026 16:26:51 GMT</pubDate>
    <link>https://podcasters.spotify.com/pod/show/mlops/episodes/Inside-a-Game</link>
    <enclosure url="https://anchor.fm/s/174cb1b8/podcast/play/127115050/file.mp3" type="audio/mpeg" length="1"/>
    <itunes:duration>01:01:03</itunes:duration>
    <itunes:image href="https://cdn.test/ep1.jpg"/>
  </item>
  <item>
    <title>Second &amp; Third</title>
    <guid>guid-2</guid>
    <pubDate>Wed, 01 Oct 2026 09:00:00 GMT</pubDate>
    <enclosure url="https://anchor.fm/s/174cb1b8/podcast/play/2/f.mp3" type="audio/mpeg"/>
    <itunes:duration>2515</itunes:duration>
    <itunes:episode>42</itunes:episode>
  </item>
  <item>
    <title>No guid here</title>
  </item>
</channel>
</rss>`;

describe('parseFeed', () => {
  const feed = parseFeed(FEED);

  it('reads the show', () => {
    expect(feed.title).toBe('Agentic Conversations (formally mlops.community)');
    expect(feed.description).toBe('Talks & interviews');
    expect(feed.imageUrl).toBe('https://cdn.test/cover.jpg');
  });

  it('reads every episode that has a guid and a title', () => {
    expect(feed.episodes).toHaveLength(2);
    expect(feed.episodes[0].guid).toBe('5cbf4845-c44c-4cd5-a502-6b8b4faac06d');
    expect(feed.episodes[0].title).toBe('Inside a Game Where AI Agents Never Sleep');
  });

  it('COUNTS what it could not read rather than dropping it silently', () => {
    // A feed that quietly loses episodes is worse than one that fails.
    expect(feed.skipped).toBe(1);
  });

  it('pulls the enclosure URL, which is the join key to OP3', () => {
    // OP3 sits in front of the enclosure and counts requests, so this URL is
    // how its numbers get back to our rows.
    expect(feed.episodes[0].audioUrl).toBe('https://anchor.fm/s/174cb1b8/podcast/play/127115050/file.mp3');
  });

  it('handles both duration shapes the feed uses', () => {
    expect(feed.episodes[0].durationSeconds).toBe(3663);
    expect(feed.episodes[1].durationSeconds).toBe(2515);
  });

  it('decodes entities in a non-CDATA title', () => {
    expect(feed.episodes[1].title).toBe('Second & Third');
  });

  it('reads an episode number only when there is one', () => {
    expect(feed.episodes[0].episodeNumber).toBeNull();
    expect(feed.episodes[1].episodeNumber).toBe(42);
  });

  it('returns an empty feed rather than throwing on rubbish', () => {
    expect(parseFeed('').episodes).toEqual([]);
    expect(parseFeed('<rss></rss>').episodes).toEqual([]);
  });
});

describe('decodeXmlText', () => {
  it('unwraps CDATA', () => {
    expect(decodeXmlText('<![CDATA[hello & goodbye]]>')).toBe('hello & goodbye');
  });

  it('decodes numeric entities BEFORE the bare ampersand', () => {
    // &#38; is itself an ampersand. Decoding &amp; first would turn
    // "&amp;#38;" into "&#38;" and then into "&", losing a level.
    expect(decodeXmlText('a &#38; b')).toBe('a & b');
    expect(decodeXmlText('&#x26;')).toBe('&');
    expect(decodeXmlText('Q&amp;A')).toBe('Q&A');
  });

  it('decodes the five XML entities', () => {
    expect(decodeXmlText('&lt;b&gt; &quot;x&quot; &apos;y&apos;')).toBe('<b> "x" \'y\'');
  });
});

describe('parseDuration', () => {
  it('reads all three shapes found in the wild', () => {
    expect(parseDuration('01:01:03')).toBe(3663);
    expect(parseDuration('41:55')).toBe(2515);
    expect(parseDuration('2515')).toBe(2515);
  });

  it('returns null rather than 0 for something unreadable', () => {
    // 0 would claim an episode is empty.
    expect(parseDuration('nonsense')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration('-1:00')).toBeNull();
  });
});

describe('parsePubDate', () => {
  it('converts RFC 822 to ISO', () => {
    expect(parsePubDate('Thu, 08 Oct 2026 16:26:51 GMT')).toBe('2026-10-08T16:26:51.000Z');
  });

  it('returns null rather than inventing a date', () => {
    expect(parsePubDate('soon')).toBeNull();
    expect(parsePubDate(null)).toBeNull();
  });
});

describe('tagText and tagAttr', () => {
  it('reads a tag that carries attributes', () => {
    expect(tagText('<guid isPermaLink="false">abc</guid>', 'guid')).toBe('abc');
  });

  it('reads an attribute off a self-closing tag', () => {
    expect(tagAttr('<itunes:image href="https://x/y.jpg"/>', 'itunes:image', 'href')).toBe('https://x/y.jpg');
    expect(tagAttr('<enclosure url="https://x/a.mp3" type="audio/mpeg"/>', 'enclosure', 'url'))
      .toBe('https://x/a.mp3');
  });

  it('returns null for an absent tag or attribute', () => {
    expect(tagText('<a>x</a>', 'b')).toBeNull();
    expect(tagAttr('<a href="x"/>', 'a', 'src')).toBeNull();
  });
});
