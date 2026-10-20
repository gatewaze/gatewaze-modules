// Inputs a hostile feed or page could send. Every parser here must stay
// linear: the security review measured the earlier regexes at 3.4 s for
// 100k unclosed tags, which extrapolates to hours for a 5 MB page and would
// stall the API process during a resolve. Budgets are generous (CI boxes
// are slow); the point is the SHAPE, not the constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, stripHtml, tagText, decodeEntities } from '../lib/feed-parser.js';
import { articleBody, headTags, publishedDate, pageDescription, parseSitemap, sanitizeBody } from '../lib/html-meta.js';
import { cleanText, entryBlurb } from '../lib/blurb.js';
import { policeUrl, conditionalHeaders } from '../lib/http.js';

const timed = (label, fn, budgetMs) => {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  assert.ok(ms < budgetMs, `${label} took ${ms.toFixed(0)}ms (budget ${budgetMs}ms)`);
  return r;
};

test('a million unclosed "<" strips in linear time', () => {
  const s = '<'.repeat(1_000_000);
  const out = timed('stripHtml', () => stripHtml(s), 400);
  assert.equal(typeof out, 'string');
  timed('cleanText', () => cleanText(s), 400);
});

test('300k unclosed <title> tags parse in linear time and yield no entries', () => {
  const xml = '<rss><channel>' + '<item><title>'.repeat(300_000);
  const f = timed('parseFeed', () => parseFeed(xml), 1500);
  assert.equal(f.entries.length, 0);
  assert.equal(timed('tagText', () => tagText(xml, 'title'), 400), null);
});

test('100k <meta tags and a </head> at the very end stay within the head cap', () => {
  const closed = '<html><head>' + '<meta property="og:title" content="x">'.repeat(100_000) + '</head><body></body></html>';
  const tags = timed('headTags(closed)', () => headTags(closed), 600);
  assert.ok(tags.length > 0 && tags.length < 100_000, 'capped at 200 KB of head');
  timed('pageDescription', () => pageDescription(closed, tags), 200);
  timed('publishedDate', () => publishedDate(closed, tags), 600);
  // never-closed tags match nothing, and still cost linear time
  const open = '<html><head>' + '<meta property="og:title" content="x" '.repeat(100_000) + '</head>';
  assert.equal(timed('headTags(unclosed)', () => headTags(open), 600).length, 0);
});

test('100k unclosed <article>, <main> and <div class="entry-content"> openers', () => {
  for (const opener of ['<article>', '<main>', '<div class="entry-content">', '<nav>']) {
    const html = '<html><body><main>' + opener.repeat(100_000) + '</body></html>';
    timed(`articleBody(${opener})`, () => articleBody(html), 800);
  }
});

test('entities decode once; a decoded tag never survives as a tag', () => {
  assert.equal(decodeEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;');
  // double-encoded <img onerror> arrives as text and is dropped, not stored as markup
  // one decode leaves the inner entities as text; a second would have made a tag
  assert.equal(stripHtml('&amp;lt;img src=x onerror=alert(1)&amp;gt;hello'), '&lt;img src=x onerror=alert(1)&gt;hello');
  assert.ok(!/<img/.test(stripHtml('&amp;lt;img src=x onerror=alert(1)&amp;gt;hello')));
  assert.equal(stripHtml('&lt;b&gt;bold&lt;/b&gt;'), 'bold');
  assert.equal(entryBlurb({ title: 'T', excerpt: '&lt;script&gt;alert(1)&lt;/script&gt; A sentence that is long enough to count here.' }), 'alert(1) A sentence that is long enough to count here.');
  assert.equal(decodeEntities('&#99999999;&#x110000;'), '&#99999999;&#x110000;');
});

test('sitemap parser caps entries and is linear on junk', () => {
  const xml = '<urlset>' + '<url><loc>https://x.org/'.repeat(200_000);
  const s = timed('parseSitemap', () => parseSitemap(xml), 800);
  assert.equal(s.entries.length, 0);
});

test('sanitizeBody fails closed when sanitize-html is unavailable', async () => {
  // In this test environment the dependency is not installed; the body must
  // come back empty rather than through a weaker fallback.
  let hasDep = true;
  try { await import('sanitize-html'); } catch { hasDep = false; }
  const out = await sanitizeBody('<p onclick="x()">hi</p><img src=x onerror=alert(1)><a href="javascript:alert(1)">l</a>');
  if (!hasDep) assert.equal(out, null);
  else {
    assert.ok(!/onerror|onclick|javascript:/i.test(out));
    assert.ok(!/<img/i.test(out), 'an img without an absolute https src is dropped');
    const kept = await sanitizeBody('<p>x</p><img src="https://a.org/i.png" alt="a"><img src="/local.png"><img src="//cdn.x/i.png">');
    assert.equal((kept.match(/<img/g) || []).length, 1);
    assert.match(kept, /src="https:\/\/a\.org\/i\.png"/);
  }
});

test('policeUrl refuses internal-looking hosts without saying why they resolve', () => {
  for (const bad of ['https://redis/', 'https://postgres.default.svc.cluster.local/', 'https://api.svc/', 'https://example.org./', 'https://10.0.0.1/', 'https://localhost/', 'https://x.internal/', 'https://example.org:8443/', 'http://example.org/']) {
    assert.throws(() => policeUrl(bad), /not allowed|scheme|port/, bad);
  }
  assert.equal(policeUrl('https://blog.example.org/feed/').hostname, 'blog.example.org');
});

test('policeUrl: credentials, length, mDNS and home.arpa hosts refused; explicit :443 allowed', () => {
  assert.throws(() => policeUrl('https://user:pass@example.org/feed/'), /credentials/);
  assert.throws(() => policeUrl('https://user@example.org/feed/'), /credentials/);
  assert.throws(() => policeUrl(`https://example.org/${'a'.repeat(2050)}`), /too long/);
  assert.equal(policeUrl(`https://example.org/${'a'.repeat(2000)}`).hostname, 'example.org');
  for (const bad of ['https://printer.local/', 'https://nas.home.arpa/feed', 'https://router.HOME.ARPA/', 'https://[::1]/', 'https://[fd00::1]/']) {
    assert.throws(() => policeUrl(bad), /not allowed/, bad);
  }
  const u = policeUrl('https://example.org:443/feed/');
  assert.equal(u.port, '');
  assert.equal(u.toString(), 'https://example.org/feed/');
});

test('conditional GET validators with CR/LF or control characters are dropped, not sent', () => {
  assert.deepEqual(conditionalHeaders('"abc"', 'Thu, 17 Sep 2026 12:00:00 GMT'), {
    'If-None-Match': '"abc"',
    'If-Modified-Since': 'Thu, 17 Sep 2026 12:00:00 GMT',
  });
  for (const bad of ['"abc"\r\nX-Injected: 1', '"abc"\nX: 1', '"a\u0000b"', '"\u00e9tag"', 'x'.repeat(257), '']) {
    assert.equal(conditionalHeaders(bad, null)['If-None-Match'], undefined, JSON.stringify(bad));
  }
  for (const bad of ['Thu, 17 Sep 2026\r\nX-Injected: 1', 'Thu\t17', 'x'.repeat(65)]) {
    assert.equal(conditionalHeaders(null, bad)['If-Modified-Since'], undefined, JSON.stringify(bad));
  }
  assert.deepEqual(conditionalHeaders(42, { toString: () => 'x' }), {});
});
