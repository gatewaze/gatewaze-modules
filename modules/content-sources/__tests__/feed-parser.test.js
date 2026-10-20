import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, decodeXmlText, looksLikeFeed, parseDate } from '../lib/feed-parser.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>CNCF</title><link>https://www.cncf.io/</link><lastBuildDate>Tue, 20 Oct 2026 10:00:00 GMT</lastBuildDate>
<item><title><![CDATA[OpenTelemetry everywhere &amp; more]]></title><link>https://www.cncf.io/blog/2026/09/17/otel/</link><guid isPermaLink="false">cncf-1</guid>
 <pubDate>Thu, 17 Sep 2026 12:00:00 +0000</pubDate><description><![CDATA[<p>For most of the <b>last decade</b> our metrics pipeline ran on gostatsd.</p>]]></description>
 <content:encoded><![CDATA[<p>Long body</p>]]></content:encoded></item>
<item><title>No link item</title><guid isPermaLink="false">x</guid><pubDate>Thu, 17 Sep 2026 12:00:00 +0000</pubDate></item>
<item><title>Permalink guid</title><guid isPermaLink="true">https://www.cncf.io/blog/p2/</guid><dc:date>2026-09-18T09:00:00Z</dc:date></item>
<item><title>Undated</title><link>/relative/path</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Valkey</title><link rel="self" href="https://valkey.io/atom.xml"/><link rel="alternate" href="https://valkey.io/"/><updated>2026-10-20T00:00:00Z</updated>
<entry><title>Keeping up with AI</title><link rel="alternate" type="text/html" href="https://valkey.io/blog/keeping-up/"/><id>tag:valkey.io,2026:1</id>
 <published>2026-09-17T00:00:00Z</published><updated>2026-09-18T00:00:00Z</updated><summary type="html">&lt;p&gt;We published five advisories.&lt;/p&gt;</summary></entry>
<entry><title>Only updated</title><link href="https://valkey.io/blog/only-updated/"/><id>2</id><updated>2026-09-19T00:00:00Z</updated><content type="html">Content &#x27;here&#x27;</content></entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://example.org/"><title>RDF site</title><link>https://example.org/</link></channel>
<item rdf:about="https://example.org/post-1"><title>RDF post</title><link>https://example.org/post-1</link><dc:date>2026-09-20T00:00:00Z</dc:date><description>Desc</description></item>
</rdf:RDF>`;

test('RSS 2.0: titles, links, CDATA, entities, guid permalink, dc:date, relative links, no-link skipped', () => {
  const f = parseFeed(RSS, 'https://www.cncf.io/feed/');
  assert.equal(f.kind, 'rss');
  assert.equal(f.title, 'CNCF');
  assert.equal(f.siteUrl, 'https://www.cncf.io/');
  assert.equal(f.skipped, 1);
  assert.equal(f.entries.length, 3);
  const [a, b, c] = f.entries;
  assert.equal(a.title, 'OpenTelemetry everywhere & more');
  assert.equal(a.link, 'https://www.cncf.io/blog/2026/09/17/otel/');
  assert.equal(a.guid, 'cncf-1');
  assert.equal(a.publishedAt, '2026-09-17T12:00:00.000Z');
  assert.equal(a.summary, 'For most of the last decade our metrics pipeline ran on gostatsd.');
  assert.equal(b.link, 'https://www.cncf.io/blog/p2/');
  assert.equal(b.publishedAt, '2026-09-18T09:00:00.000Z');
  assert.equal(c.link, 'https://www.cncf.io/relative/path');
  assert.equal(c.publishedAt, null);
});

test('Atom: alternate link, published vs updated, html summary, content fallback', () => {
  const f = parseFeed(ATOM, 'https://valkey.io/atom.xml');
  assert.equal(f.kind, 'atom');
  assert.equal(f.siteUrl, 'https://valkey.io/');
  assert.equal(f.entries.length, 2);
  assert.equal(f.entries[0].link, 'https://valkey.io/blog/keeping-up/');
  assert.equal(f.entries[0].publishedAt, '2026-09-17T00:00:00.000Z');
  assert.equal(f.entries[0].updatedAt, '2026-09-18T00:00:00.000Z');
  assert.equal(f.entries[0].summary, 'We published five advisories.');
  assert.equal(f.entries[1].publishedAt, null);
  assert.equal(f.entries[1].updatedAt, '2026-09-19T00:00:00.000Z');
  assert.equal(f.entries[1].summary, "Content 'here'");
});

test('RDF/RSS 1.0', () => {
  const f = parseFeed(RDF, 'https://example.org/');
  assert.equal(f.kind, 'rdf');
  assert.equal(f.entries.length, 1);
  assert.equal(f.entries[0].link, 'https://example.org/post-1');
  assert.equal(f.entries[0].publishedAt, '2026-09-20T00:00:00.000Z');
});

test('feed-level dates are never used as entry dates', () => {
  const f = parseFeed(RSS);
  for (const e of f.entries) assert.notEqual(e.publishedAt, '2026-10-20T10:00:00.000Z');
});

test('not a feed → unknown; HTML is not a feed', () => {
  assert.equal(parseFeed('<html><body>hi</body></html>').kind, 'unknown');
  assert.equal(looksLikeFeed('<!doctype html><html>'), false);
  assert.equal(looksLikeFeed(RSS), true);
});

test('decodeXmlText + parseDate', () => {
  assert.equal(decodeXmlText('<![CDATA[a &amp; b]]>'), 'a & b');
  assert.equal(decodeXmlText('&#38;&#x26;&lt;'), '&&<');
  assert.equal(decodeXmlText('&#99999999;'), '&#99999999;'); // out of range stays literal
  assert.equal(parseDate('garbage'), null);
});
