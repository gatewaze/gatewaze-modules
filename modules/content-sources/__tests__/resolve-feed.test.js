import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFeed, PROBE_PATHS } from '../lib/resolve-feed.js';

const FEED = (title, link) => `<rss version="2.0"><channel><title>${title}</title>
<item><title>Post</title><link>${link}</link><pubDate>Thu, 17 Sep 2026 12:00:00 +0000</pubDate></item></channel></rss>`;
const UNDATED_FEED = `<rss version="2.0"><channel><title>Dead</title><item><title>Post</title><link>https://x.org/p</link></item></channel></rss>`;

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (!hit) return { status: 404, headers: {}, text: '', finalUrl: url, via: 'direct' };
    return { status: 200, headers: {}, text: hit, finalUrl: url, via: 'direct' };
  };
  fn.calls = calls;
  return fn;
}

test('probe path list matches the harvest script exactly', () => {
  assert.deepEqual(PROBE_PATHS, ['/feed/', '/feed.xml', '/rss.xml', '/index.xml', '/atom.xml', '/blog/index.xml', '/blog/feed/', '/blog/rss.xml', '/blog/feed.xml', '/news/feed/', '/feed.rss', '/blog/atom.xml']);
});

test('alternate link discovered from the page; cross-domain flagged not preferred', async () => {
  const fetch = fakeFetch({
    'https://example.org/': `<html><head><link rel="alternate" type="application/rss+xml" href="/blog/feed/"><link rel="alternate" type="application/atom+xml" href="https://medium.com/feed/other"></head></html>`,
    'https://example.org/blog/feed/': FEED('Example blog', 'https://example.org/blog/p1'),
    'https://medium.com/feed/other': FEED('Medium', 'https://medium.com/p'),
  });
  const r = await resolveFeed('https://example.org', { fetch });
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].feed_url, 'https://example.org/blog/feed/');
  assert.equal(r.candidates[0].cross_domain, false);
  assert.equal(r.candidates[0].found_via, 'alternate');
  assert.equal(r.candidates[1].cross_domain, true);
});

test('probing in order when no alternate; section feed preferred over Hugo root index.xml', async () => {
  const fetch = fakeFetch({
    'https://hugo.org/': '<html><head></head></html>',
    'https://hugo.org/index.xml': FEED('Site', 'https://hugo.org/docs/x'),
    'https://hugo.org/blog/index.xml': FEED('Blog', 'https://hugo.org/blog/x'),
  });
  const r = await resolveFeed('https://hugo.org', { fetch, probeAll: true });
  assert.equal(r.candidates[0].feed_url, 'https://hugo.org/blog/index.xml');
  assert.equal(r.candidates[1].is_root_index, true);
  // probe order honoured
  const probed = fetch.calls.filter((u) => u !== 'https://hugo.org/');
  assert.equal(probed[0], 'https://hugo.org/feed/');
});

test('a feed with no dated entries is not a candidate; the site URL itself may be the feed', async () => {
  const fetch = fakeFetch({ 'https://x.org/feed/': UNDATED_FEED, 'https://x.org/': '<html></html>' });
  const r = await resolveFeed('https://x.org', { fetch, probeAll: true });
  assert.equal(r.candidates.length, 0);
  const fetch2 = fakeFetch({ 'https://y.org/rss.xml': FEED('Y', 'https://y.org/p') });
  const r2 = await resolveFeed('https://y.org/rss.xml', { fetch: fetch2 });
  assert.equal(r2.candidates.length, 1);
  assert.equal(r2.candidates[0].feed_url, 'https://y.org/rss.xml');
});

test('http and private site URLs are refused before any fetch', async () => {
  await assert.rejects(() => resolveFeed('http://example.org'), /scheme/);
  await assert.rejects(() => resolveFeed('https://10.0.0.1/'), /host not allowed/);
  await assert.rejects(() => resolveFeed('https://localhost/'), /host not allowed/);
  await assert.rejects(() => resolveFeed('https://redis/'), /host not allowed/);
  const fetch = fakeFetch({ 'https://example.org/': `<html><head><link rel="alternate" type="application/rss+xml" href="http://example.org/feed/"></head></html>` });
  const r = await resolveFeed('https://example.org', { fetch });
  assert.equal(r.candidates.length, 0);
  assert.ok(r.errors.some((e) => /scheme http/.test(e)));
});
