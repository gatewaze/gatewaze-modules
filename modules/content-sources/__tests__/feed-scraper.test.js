// FeedScraper write rules, run guard, egress auto-flip and sitemap filter,
// against a recording fake supabase client. No network: fetchSource is
// stubbed per test and the pure helpers are exercised directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedScraper, shouldFlipEgress, sitemapCandidates } from '../scrapers/FeedScraper.js';
import { normalizeUrl } from '../lib/normalize-url.js';

/**
 * Fake supabase: every chain is recorded as { table, op, calls: [[method, ...args]] }
 * and resolves through `respond(entry)` (default: empty success).
 */
function fakeSupabase(respond = () => ({ data: null, error: null })) {
  const log = [];
  const builder = (table) => {
    const entry = { table, op: null, payload: null, calls: [] };
    const result = () => Promise.resolve(respond(entry) ?? { data: null, error: null });
    const proxy = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (ok, bad) => result().then(ok, bad);
        return (...args) => {
          if (['select', 'insert', 'update', 'delete', 'upsert'].includes(prop) && !entry.op) {
            entry.op = prop;
            entry.payload = args[0];
            log.push(entry);
          }
          entry.calls.push([prop, ...args]);
          if (prop === 'maybeSingle' || prop === 'single') return result();
          return proxy;
        };
      },
    });
    return proxy;
  };
  return {
    log,
    from: (table) => builder(table),
    rpc: async (fn, args) => {
      log.push({ table: null, op: 'rpc', fn, payload: args, calls: [] });
      return { data: null, error: null };
    },
    writes: (table) => log.filter((e) => e.table === table && ['insert', 'update', 'delete', 'upsert'].includes(e.op)),
  };
}

const SRC = { id: 'src-a', project: 'A', foundation: 'F', feed_url: 'https://a.example.org/feed/', egress: 'direct', egress_locked: false, last_error: null, consecutive_failures: 0 };
const ENTRY = { title: 'Hello world', link: 'https://a.example.org/blog/hello', guid: null, publishedAt: '2026-10-18T00:00:00.000Z', updatedAt: null, summary: 'Hi' };

function scraperWith(sb, index = []) {
  const s = new FeedScraper({ config: {} }, { supabase: sb, logger: { log() {} } });
  const byUrl = new Map(index.map((row) => [row.canonical_url_norm, row]));
  s._index = { byUrl, byTitle: new Map() };
  return s;
}

test('never touches a row with no discovery_source_id (another scraper or a human owns it)', async () => {
  const sb = fakeSupabase();
  const s = scraperWith(sb, [{ id: 'p1', canonical_url_norm: normalizeUrl(ENTRY.link), discovery_source_id: null, status: 'pending_review' }]);
  await s.upsertEntry(sb, SRC, ENTRY, '2026-10-01T00:00:00.000Z');
  assert.equal(s.stats.owned_elsewhere, 1);
  assert.equal(sb.writes('blog_posts').length, 0);
});

test('a URL another source already owns is collapsed, not rewritten', async () => {
  const sb = fakeSupabase();
  const s = scraperWith(sb, [{ id: 'p1', canonical_url_norm: normalizeUrl(ENTRY.link), discovery_source_id: 'src-b', status: 'pending_review' }]);
  await s.upsertEntry(sb, SRC, ENTRY, '2026-10-01T00:00:00.000Z');
  assert.equal(s.stats.collapsed_url, 1);
  assert.equal(sb.writes('blog_posts').length, 0);
});

test('a published (or rejected) row from the same source is skipped: a human decided', async () => {
  for (const status of ['published', 'rejected']) {
    const sb = fakeSupabase();
    const s = scraperWith(sb, [{ id: 'p1', canonical_url_norm: normalizeUrl(ENTRY.link), discovery_source_id: SRC.id, status }]);
    await s.upsertEntry(sb, SRC, ENTRY, '2026-10-01T00:00:00.000Z');
    assert.equal(s.stats.skipped, 1, status);
    assert.equal(sb.writes('blog_posts').length, 0, status);
  }
});

test('a pending row from the same source is updated in place; a new URL is inserted pending_review', async () => {
  const sb = fakeSupabase((e) => (e.op === 'insert' ? { data: { id: 'new-1' }, error: null } : { data: null, error: null }));
  const s = scraperWith(sb, [{ id: 'p1', canonical_url_norm: normalizeUrl(ENTRY.link), discovery_source_id: SRC.id, status: 'pending_review' }]);
  await s.upsertEntry(sb, SRC, ENTRY, '2026-10-01T00:00:00.000Z');
  await s.upsertEntry(sb, SRC, { ...ENTRY, title: 'Other', link: 'https://a.example.org/blog/other' }, '2026-10-01T00:00:00.000Z');
  const [upd, ins] = sb.writes('blog_posts');
  assert.equal(upd.op, 'update');
  assert.deepEqual(upd.calls.find((c) => c[0] === 'eq'), ['eq', 'id', 'p1']);
  assert.equal(ins.op, 'insert');
  assert.equal(ins.payload.status, 'pending_review');
  assert.equal(ins.payload.discovery_source_id, SRC.id);
});

test('every source failed: the run throws "network dead" and inserts nothing', async () => {
  const sb = fakeSupabase((e) => {
    if (e.table === 'discovery_sources' && e.op === 'select') return { data: [SRC, { ...SRC, id: 'src-b', project: 'B', feed_url: 'https://b.example.net/feed/' }], error: null };
    if (e.table === 'blog_posts' && e.op === 'select') return { data: [], error: null };
    return { data: null, error: null };
  });
  const s = new FeedScraper({ config: {} }, { supabase: sb, logger: { log() {} } });
  s.fetchSource = async (source) => ({ source, status: 'failed', reason: 'timeout', entries: [] });
  await assert.rejects(() => s.scrape(), /network dead/);
  assert.equal(sb.writes('blog_posts').length, 0);
  // Health is still written for both sources.
  assert.equal(sb.writes('discovery_sources').length, 2);
});

test('every post write failing fails the run with the first database error', async () => {
  const sb = fakeSupabase((e) => {
    if (e.table === 'discovery_sources' && e.op === 'select') return { data: [SRC], error: null };
    // A single-row lookup finds nothing; the index load gets an empty list.
    if (e.table === 'blog_posts' && e.op === 'select') return { data: e.calls.some((c) => c[0] === 'maybeSingle') ? null : [], error: null };
    if (e.table === 'blog_posts' && e.op === 'insert') return { data: null, error: { message: 'new row for relation "blog_posts" violates check constraint "blog_posts_status_check"' } };
    return { data: null, error: null };
  });
  const s = new FeedScraper({ config: {} }, { supabase: sb, logger: { log() {} } });
  const fresh = new Date(Date.now() - 3_600_000).toISOString();
  s.fetchSource = async (source) => ({ source, status: 'ok', entries: [{ ...ENTRY, publishedAt: fresh }, { ...ENTRY, title: 'Two', link: 'https://a.example.org/blog/two', publishedAt: fresh }] });
  await assert.rejects(() => s.scrape(), /every post write failed \(2\); first error: .*blog_posts_status_check/);
});

test('loadSources never selects html-kind rows, sweep or single-source', async () => {
  for (const options of [{}, { source_ids: ['src-a'] }]) {
    const sb = fakeSupabase(() => ({ data: [], error: null }));
    const s = new FeedScraper({ config: {}, options }, { supabase: sb, logger: { log() {} } });
    await s.loadSources(sb);
    const q = sb.log.find((e) => e.table === 'discovery_sources');
    assert.ok(q.calls.some((c) => c[0] === 'neq' && c[1] === 'kind' && c[2] === 'html'), JSON.stringify(options));
  }
});

test('selfPersisting is set so the job handler records these stats', () => {
  assert.equal(new FeedScraper().selfPersisting, true);
});

// ── Egress auto-flip ────────────────────────────────────────────────────────
const prev403 = { ...SRC, last_error: 'status=403' };
const now403 = { status: 'failed', reason: 'status=403' };
const healthy = { guardTripped: false, failureRate: 0.1 };

test('egress flips only in the base case: 403 now and before, direct, unlocked, healthy run', () => {
  assert.equal(shouldFlipEgress(prev403, now403, healthy), true);
  // Invert each condition in turn.
  assert.equal(shouldFlipEgress(prev403, { status: 'failed', reason: 'status=500' }, healthy), false, 'not a 403 now');
  assert.equal(shouldFlipEgress({ ...prev403, last_error: 'timeout' }, now403, healthy), false, 'previous failure not a 403');
  assert.equal(shouldFlipEgress({ ...prev403, egress: 'residential' }, now403, healthy), false, 'already residential');
  assert.equal(shouldFlipEgress({ ...prev403, egress_locked: true }, now403, healthy), false, 'locked');
  assert.equal(shouldFlipEgress(prev403, now403, { ...healthy, guardTripped: true }), false, 'guard tripped');
  assert.equal(shouldFlipEgress(prev403, now403, { ...healthy, failureRate: 0.25 }), false, 'failure rate too high');
});

test('writeHealth applies the flip in the base case and not when the guard tripped', async () => {
  for (const [guardTripped, expectFlip] of [[false, true], [true, false]]) {
    const sb = fakeSupabase();
    const s = new FeedScraper({ config: {} }, { supabase: sb, logger: { log() {} } });
    await s.writeHealth(sb, [{ source: prev403, ...now403 }], { failureRate: 0.1, guardTripped });
    const [upd] = sb.writes('discovery_sources');
    assert.equal(upd.payload.egress === 'residential', expectFlip, `guardTripped=${guardTripped}`);
    assert.equal(s.stats.egress_flipped, expectFlip ? 1 : 0);
  }
});

// ── Sitemap filter ──────────────────────────────────────────────────────────
test('sitemap keeps only same-domain URLs under the prefix, in window, newest first', () => {
  const entries = [
    { loc: 'https://www.example.org/blog/new', lastmod: '2026-10-18T00:00:00Z' },
    { loc: 'https://www.example.org/blog/old', lastmod: '2026-01-01T00:00:00Z' }, // out of window
    { loc: 'https://www.example.org/blog/', lastmod: '2026-10-18T00:00:00Z' }, // the prefix page itself
    { loc: 'https://www.example.org/docs/x', lastmod: '2026-10-18T00:00:00Z' }, // outside the prefix
    { loc: 'https://evil.test/blog/x', lastmod: '2026-10-18T00:00:00Z' }, // other domain
    { loc: 'https://www.example.org/blog/undated' }, // undated: unrankable
    { loc: 'https://www.example.org/blog/mid', lastmod: '2026-10-10T00:00:00Z' },
  ];
  const out = sitemapCandidates(entries, { sitemapUrl: 'https://www.example.org/sitemap.xml', prefix: 'https://www.example.org/blog', cutoff: '2026-10-01T00:00:00Z', cap: 60 });
  assert.deepEqual(out.map((e) => e.loc), ['https://www.example.org/blog/new', 'https://www.example.org/blog/mid']);
  assert.equal(sitemapCandidates(entries, { sitemapUrl: 'https://www.example.org/sitemap.xml', prefix: 'https://www.example.org/blog/', cutoff: '2026-10-01T00:00:00Z', cap: 1 }).length, 1);
  assert.deepEqual(sitemapCandidates(entries, { sitemapUrl: 'https://www.example.org/sitemap.xml', prefix: '', cutoff: '2026-10-01T00:00:00Z', cap: 60 }), []);
  // A prefix pointing at another domain than the sitemap yields nothing.
  assert.deepEqual(sitemapCandidates(entries, { sitemapUrl: 'https://www.example.org/sitemap.xml', prefix: 'https://evil.test/blog/', cutoff: '2026-10-01T00:00:00Z', cap: 60 }), []);
  // Same registrable domain, different subdomain, is kept.
  assert.equal(sitemapCandidates([{ loc: 'https://blog.example.org/p/x', lastmod: '2026-10-18T00:00:00Z' }], { sitemapUrl: 'https://www.example.org/sitemap.xml', prefix: 'https://blog.example.org/p/', cutoff: '2026-10-01T00:00:00Z', cap: 60 }).length, 1);
});
