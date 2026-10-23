import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleBody, feedAlternates, publishedDate, pageDescription, canonicalLink, parseSitemap, sanitizeBody, truncateAtBlock, BODY_MAX_CHARS, pageImage, imageUrlForStorage } from '../lib/html-meta.js';
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

// ── Post-body containers measured on LF dev ────────────────────────────────

const para = (n) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} ${long}</p>`).join('\n');

test('articleBody: HubSpot #hs_cos_wrapper_post_body wins over a related-post <article> card', () => {
  // linuxfoundation.org shape: the post is a <span> full of nested <span>s;
  // the only <article> on the page is a short related-post card.
  const html = `<html><body><header><nav>Home Blog Projects</nav></header><main>
    <div class="blog-post"><h1>How should enterprises transition</h1>
    <span id="hs_cos_wrapper_post_body" class="hs_cos_wrapper hs_cos_wrapper_meta_field hs_cos_wrapper_type_rich_text" style="" data-hs-cos-general-type="meta_field" data-hs-cos-type="rich_text">
      <p>First <span style="font-weight: bold;">bold</span> paragraph. ${long}</p>
      <p><span><span>Nested spans</span> keep going</span> ${long}</p>
      <p>Last paragraph of the post.</p>
    </span></div>
    <section class="related"><article class="card"><h3>Related post</h3><p>${'A related teaser card. '.repeat(6)}</p></article></section>
  </main><footer>Copyright</footer></body></html>`;
  const b = articleBody(html);
  const t = stripHtml(b);
  assert.ok(t.startsWith('First bold paragraph.'), t.slice(0, 60));
  assert.ok(t.endsWith('Last paragraph of the post.'), t.slice(-60));
  assert.ok(!t.includes('Related post'));
  assert.ok(!t.includes('Home Blog'));
});

test('articleBody: HubSpot body matched by class when it has no id (finos.org-style templates)', () => {
  const html = `<html><body><div class="post-header">Tags</div><div class="hs_cos_wrapper hs_cos_wrapper_post_body"><p>${long}</p><div><p>inner div</p></div></div><div class="post-footer">share</div></body></html>`;
  const t = stripHtml(articleBody(html));
  assert.ok(t.startsWith('Lorem ipsum'));
  assert.ok(t.includes('inner div'));
  assert.ok(!t.includes('share'));
});

test('articleBody: Google Developers Blog <section class="blocks-container"> with nested sections', () => {
  // The summary, author and related sections are siblings of blocks-container.
  const html = `<html><body><main>
    <section class="heading-container glue-page"><h1>Gemini 4 Argon for robotics</h1></section>
    <section class="summary-container glue-page"><div class="published-date">OCT. 13, 2026</div></section>
    <section class="blocks-container glue-page glue-spacer-3-top">
      <div class="block"><img class="banner-image" src="https://storage.googleapis.com/x/hero.png" alt="hero"/>
        <div class="inner-block-content rich-content"><p>Gemini 4 Argon marks a step change. ${long}</p></div></div>
      <section class="inner"><div class="inner-block-content code-block"><pre><code>print("hi")</code></pre></div></section>
      <div class="block"><div class="inner-block-content rich-content"><p>The closing paragraph.</p></div></div>
    </section>
    <section class="tags-container glue-page">Robotics AI</section>
    <section class="related-posts-container glue-page"><article><p>${'Another post you might like. '.repeat(10)}</p></article></section>
  </main></body></html>`;
  const b = articleBody(html);
  const t = stripHtml(b);
  assert.ok(t.startsWith('Gemini 4 Argon marks a step change.'), t.slice(0, 60));
  assert.ok(t.includes('print("hi")'));
  assert.ok(t.endsWith('The closing paragraph.'), t.slice(-60));
  assert.ok(!t.includes('OCT. 13'));
  assert.ok(!t.includes('Another post you might like'));
});

test('articleBody: <div class="article-content"> is taken whole (blog.cloudflare.com)', () => {
  const html = `<html><body><main><article><div class="tags">Blog Cryptography Security 2 Tags</div>
    <div class="article-content"><p>On October 19 ${long}</p><div><figure><img src="https://x.org/a.png"></figure></div><p>Final words.</p></div>
    <section class="post-email">Subscribe to receive notifications of new posts</section></article></main></body></html>`;
  const t = stripHtml(articleBody(html));
  assert.ok(t.startsWith('On October 19'));
  assert.ok(t.endsWith('Final words.'));
  assert.ok(!t.includes('Subscribe'));
  assert.ok(!t.includes('Cryptography'));
});

test('articleBody: an <article> card holding a small share of the page loses to <main>', () => {
  const html = `<html><body><main><div class="wrap"><h1>Title</h1>${para(8)}</div>
    <aside>side</aside><div class="cards"><article><p>${'A short related card teaser. '.repeat(5)}</p></article></div></main></body></html>`;
  const t = stripHtml(articleBody(html));
  assert.ok(t.includes('Paragraph 0'));
  assert.ok(t.includes('Paragraph 7'));
});

test('articleBody: an <article> that IS the post is still preferred', () => {
  const html = `<html><body><main><nav>menu</nav><article><h1>T</h1>${para(4)}</article><div class="footer-ish">${'x '.repeat(50)}</div></main></body></html>`;
  const b = articleBody(html);
  assert.ok(b.startsWith('<article'));
  assert.ok(stripHtml(b).includes('Paragraph 3'));
});

test('articleBody: a known container that is too short or never closes falls through', () => {
  const short = `<html><body><span id="hs_cos_wrapper_post_body"><p>tiny</p></span><main><p>${long}</p></main></body></html>`;
  assert.ok(stripHtml(articleBody(short)).startsWith('Lorem ipsum'));
  const unclosed = `<html><body><main><p>${long}</p></main><section class="blocks-container"><p>${long}`;
  assert.ok(stripHtml(articleBody(unclosed)).startsWith('Lorem ipsum'));
});

// ── Truncation ─────────────────────────────────────────────────────────────

test('truncateAtBlock: cuts just after the last block closer that fits', () => {
  const html = '<p>one</p><pre>two</pre><ul><li>three</li><li>four</li></ul><h2>five</h2><p>six six six</p>';
  assert.equal(truncateAtBlock(html, 1000), html);
  assert.equal(truncateAtBlock(html, html.indexOf('<p>six') + 5), html.slice(0, html.indexOf('<p>six')));
  assert.equal(truncateAtBlock(html, 30), '<p>one</p><pre>two</pre>');
  const li = html.indexOf('</li>') + 5;
  assert.equal(truncateAtBlock(html, li + 3), html.slice(0, li));
  // No closer at all: back to the last '>' so no tag is split.
  assert.equal(truncateAtBlock('<div><span>aaaa bbbb cccc</span>', 20), '<div><span>');
  assert.equal(truncateAtBlock('abcdefghij', 4), 'abcd');
  assert.equal(BODY_MAX_CHARS, 200_000);
});

test('sanitizeBody: a long body is cut at a block boundary and stays well-formed', async () => {
  let hasDep = true;
  try { await import('sanitize-html'); } catch { hasDep = false; }
  if (!hasDep) return; // covered by truncateAtBlock above; the fail-closed path is tested elsewhere
  const body = '<ul>' + Array.from({ length: 50 }, (_, i) => `<li>item ${i} ${'x'.repeat(40)}</li>`).join('') + '</ul><p>' + 'y'.repeat(500) + '</p>';
  const out = await sanitizeBody(body, 1200);
  assert.ok(out.length <= 1200, String(out.length));
  assert.ok(out.endsWith('</li></ul>'), out.slice(-30));
  const def = await sanitizeBody('<p>' + 'z'.repeat(150_000) + '</p>');
  assert.equal(def.length, 150_007, 'a 150 KB body is no longer cut at 60 KB');
});

// ── Featured image ─────────────────────────────────────────────────────────

test('pageImage: og:image (secure_url first), then twitter:image, absolute https only', () => {
  const head = (tags) => `<html><head>${tags}</head><body></body></html>`;
  assert.equal(pageImage(head('<meta property="og:image" content="https://www.finos.org/hubfs/Blog/Image%20(1).png">'), 'https://www.finos.org/blog/x'),
    'https://www.finos.org/hubfs/Blog/Image%20(1).png');
  assert.equal(pageImage(head('<meta content="https://cdn.x.org/a.png" property="og:image"/>'), 'https://x.org/'), 'https://cdn.x.org/a.png');
  assert.equal(pageImage(head('<meta property="og:image" content="http://x.org/a.png"><meta property="og:image:secure_url" content="https://x.org/a.png">'), 'https://x.org/'), 'https://x.org/a.png');
  assert.equal(pageImage(head('<meta name="twitter:image" content="/img/card.png">'), 'https://blog.example.org/post/'), 'https://blog.example.org/img/card.png');
  assert.equal(pageImage(head('<meta property="og:image" content="javascript:alert(1)"><meta name="twitter:image" content="data:image/png;base64,AAAA">'), 'https://x.org/'), null);
  assert.equal(pageImage(head('<meta property="og:image" content="/a.png">'), 'http://x.org/'), null, 'relative to an http page is http');
  assert.equal(pageImage(head(''), 'https://x.org/'), null);
});

test('imageUrlForStorage: refuses http, credentials, IP literals, internal hosts, odd ports and over-long URLs', () => {
  assert.equal(imageUrlForStorage('https://img.example.org/a.png'), 'https://img.example.org/a.png');
  assert.equal(imageUrlForStorage('  https://img.example.org/a.png  '), 'https://img.example.org/a.png');
  for (const bad of [
    'http://img.example.org/a.png', 'https://u:p@img.example.org/a.png', 'https://10.0.0.1/a.png', 'https://[::1]/a.png',
    'https://redis/a.png', 'https://minio.svc.cluster.local/a.png', 'https://img.example.org:8443/a.png',
    `https://img.example.org/${'a'.repeat(2100)}.png`, '//img.example.org/a.png', 'javascript:alert(1)', 'not a url', '', null, 42,
  ]) {
    assert.equal(imageUrlForStorage(bad), null, String(bad).slice(0, 60));
  }
  assert.equal(imageUrlForStorage('//img.example.org/a.png', 'https://x.org/'), 'https://img.example.org/a.png');
});
