import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleBody, feedAlternates, publishedDate, pageDescription, canonicalLink, parseSitemap, sanitizeBody } from '../lib/html-meta.js';
import { stripHtml } from '../lib/feed-parser.js';

const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6);

test('articleBody: entry-content first, then largest <article>, then <main> minus chrome, then known content classes', () => {
  const wp = `<html><body><div class="entry-content"><p>${long}</p></div></article><footer>f</footer></body></html>`;
  assert.ok(stripHtml(articleBody(wp)).startsWith('Lorem ipsum'));
  const art = `<html><body><article><h1>T</h1><p>${long}</p></article><article><p>short</p></article></body></html>`;
  assert.ok(articleBody(art).includes('Lorem ipsum'));
  const hugo = `<html><body><nav>menu menu menu</nav><main><header class="x"><h1>Title</h1></header><nav>in-main nav</nav><div class="td-content"><p>${long}</p></div><aside>related</aside></main><footer>foot</footer></body></html>`;
  const b = articleBody(hugo);
  assert.ok(b.includes('Lorem ipsum'));
  assert.ok(!b.includes('in-main nav'));
  assert.ok(!b.includes('related'));
  assert.equal(articleBody('<html><body><p>tiny</p></body></html>'), null);
});

test('feedAlternates, canonicalLink, pageDescription, publishedDate', () => {
  const html = `<html><head>
    <link rel="alternate" type="application/rss+xml" title="Blog" href="/feed/">
    <link rel="alternate" type="application/atom+xml" href="https://other.org/atom.xml">
    <link rel="canonical" href="https://example.org/blog/post">
    <meta property="og:description" content="A description that is comfortably longer than thirty characters.">
    <meta property="article:published_time" content="2026-09-17T12:00:00Z">
    </head><body></body></html>`;
  const alts = feedAlternates(html, 'https://example.org/blog/');
  assert.deepEqual(alts.map((a) => a.href), ['https://example.org/feed/', 'https://other.org/atom.xml']);
  assert.equal(canonicalLink(html, 'https://example.org/'), 'https://example.org/blog/post');
  assert.match(pageDescription(html), /^A description/);
  assert.equal(publishedDate(html), '2026-09-17T12:00:00.000Z');
  assert.equal(publishedDate('<html><body><time datetime="2026-09-18T09:00:00Z">x</time></body></html>'), '2026-09-18T09:00:00.000Z');
  assert.equal(publishedDate('<html><body>Published September 19, 2026 by us</body></html>'), '2026-09-19T00:00:00.000Z');
  assert.equal(publishedDate('<html><body>no date</body></html>'), null);
  assert.equal(pageDescription('<html><head><meta name="description" content="too short"></head></html>'), null);
});

test('parseSitemap: urlset and sitemapindex', () => {
  const s = parseSitemap(`<urlset><url><loc>https://aaif.io/blog/a</loc><lastmod>2026-09-15T00:00:00+00:00</lastmod></url><url><loc>https://aaif.io/blog/b</loc></url></urlset>`);
  assert.equal(s.isIndex, false);
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries[0].lastmod, '2026-09-15T00:00:00.000Z');
  assert.equal(s.entries[1].lastmod, null);
  const i = parseSitemap(`<sitemapindex><sitemap><loc>https://aaif.io/post-sitemap.xml</loc></sitemap></sitemapindex>`);
  assert.equal(i.isIndex, true);
  assert.equal(i.entries[0].loc, 'https://aaif.io/post-sitemap.xml');
});

test('sanitizeBody: allow-list when sanitize-html is present, null (fail closed) when it is not', async () => {
  let hasDep = true;
  try { await import('sanitize-html'); } catch { hasDep = false; }
  const out = await sanitizeBody(`<p onclick="x()">hi</p><script>evil()</script><a href="javascript:alert(1)">l</a>`);
  if (!hasDep) { assert.equal(out, null); return; }
  assert.ok(!/<script/i.test(out));
  assert.ok(!/onclick/i.test(out));
  assert.ok(!/javascript:/i.test(out));
  const capped = await sanitizeBody('<p>' + 'a'.repeat(100) + '</p>', 50);
  assert.ok(capped.length <= 50);
});
