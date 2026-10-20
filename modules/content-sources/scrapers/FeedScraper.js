/**
 * FeedScraper — one scrapers-dashboard row that sweeps every active
 * discovery source (RSS/Atom/RDF feeds and sitemap targets) and lands new
 * posts in blog_posts as pending_review. Ported from the LF ED newsletter
 * blog harvest (lf-ed-newsletter-blog-harvest) per
 * spec-content-sources-and-research-blocks.md §4.3.
 *
 * Runs inside the standard scrapers infrastructure (contributed via
 * scrapers/register.js). Like the blog scrapers it persists its own rows and
 * returns [] — the handler's event pipeline is not involved.
 *
 * Phases:
 *   1. Feed pass: bounded concurrency over sources, per-host politeness,
 *      conditional GET, per-source health + egress bookkeeping, dedupe at
 *      write, ownership rule (never touch a row another scraper owns).
 *      Guard: when NO source was alive and at least one failed, the run
 *      fails ("network dead, not a quiet week") and writes no posts.
 *   2. Body backlog: posts with no body yet get their article page fetched,
 *      the body extracted + sanitised, og:description as excerpt fallback.
 *
 * Config (scrapers.config jsonb, all optional):
 *   concurrency (16), per_host (2), feed_timeout_ms (20000), page_timeout_ms (8000),
 *   lookback_days (21), body_fetch_cap (200), sitemap_page_cap (60),
 *   run_budget_minutes (20), fetch_full_content (true)
 * Per-job options (scraperConfig.options, from scrapers_jobs.metadata):
 *   source_ids: string[]  run only these sources (any status except dead)
 */

import { fetchFeedConditional, fetchText, residentialProxyUrl, FetchRefusedError, scrubSecrets } from '../lib/http.js';
import { registrableDomain } from '../lib/normalize-url.js';
import { parseFeed, looksLikeFeed } from '../lib/feed-parser.js';
import { normalizeUrl, canonicalForStorage, hostOf, slugForPost, shortHash } from '../lib/normalize-url.js';
import { excerptForStorage } from '../lib/blurb.js';
import { pageTitle, pageDescription, publishedDate, canonicalLink, articleBody, sanitizeBody, parseSitemap } from '../lib/html-meta.js';

// blog_posts.author_id is NOT NULL with no FK; the blog scrapers use this
// namespaced system uuid and the portal never displays it.
export const SYSTEM_AUTHOR_ID = '00000000-0000-0000-0000-0000aa1fb106';

const DAY = 24 * 60 * 60 * 1000;
// A WordPress article page with inlined CSS runs past 400 KB and some past 1.5 MB; 3 MB covers
// every page seen in the smoke runs while still refusing a runaway response.
const PAGE_BYTES = 3 * 1024 * 1024;

const titleKey = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dayOf = (iso) => (iso ? Math.floor(Date.parse(iso) / DAY) : null);

/** Small bounded-concurrency runner with a per-key (host) cap. */
async function runPool(items, { concurrency, perKey, keyOf, task }) {
  const inFlightByKey = new Map();
  let idx = 0;
  const next = async () => {
    while (idx < items.length) {
      const i = idx++;
      const item = items[i];
      const key = keyOf(item);
      // wait for a per-host slot
      while ((inFlightByKey.get(key) ?? 0) >= perKey) await new Promise((r) => setTimeout(r, 50));
      inFlightByKey.set(key, (inFlightByKey.get(key) ?? 0) + 1);
      try {
        await task(item);
      } finally {
        inFlightByKey.set(key, inFlightByKey.get(key) - 1);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}

export class FeedScraper {
  constructor(config = {}, globalConfig = {}) {
    this.config = config;
    this.globalConfig = globalConfig;
    this.logger = globalConfig.logger || null;
    const c = config.config || {};
    this.opts = {
      concurrency: num(c.concurrency, 16),
      perHost: num(c.per_host, 2),
      feedTimeoutMs: num(c.feed_timeout_ms, 20_000),
      pageTimeoutMs: num(c.page_timeout_ms, 8_000),
      lookbackDays: Math.min(Math.max(num(c.lookback_days, 21), 2), 60),
      bodyFetchCap: num(c.body_fetch_cap, 200),
      sitemapPageCap: num(c.sitemap_page_cap, 60),
      runBudgetMs: num(c.run_budget_minutes, 20) * 60_000,
      fetchFullContent: c.fetch_full_content !== false,
    };
    this.jobOptions = config.options || {};
    this.stats = {
      sources: 0, alive: 0, not_modified: 0, failed: 0,
      found: 0, processed: 0, inserted: 0, updated: 0, skipped: 0, failed_items: 0,
      owned_elsewhere: 0, collapsed_url: 0, collapsed_title: 0, out_of_window: 0,
      bodies_fetched: 0, bodies_failed: 0, egress_flipped: 0,
    };
    this._sb = globalConfig.supabase || null;
    this._startedAt = Date.now();
    this._proxyUrl = null;
    this._index = null; // in-memory dedupe index of recent external posts
  }

  log(msg) {
    if (this.logger?.log) this.logger.log(msg);
    else console.log(msg);
  }
  budgetLeft() {
    return this.opts.runBudgetMs - (Date.now() - this._startedAt);
  }
  async initialize() {}
  async cleanup() {}

  async getSupabase() {
    if (this._sb) return this._sb;
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('[content-sources] SUPABASE env required');
    const { createClient } = await import('@supabase/supabase-js');
    this._sb = createClient(url, key, { auth: { persistSession: false } });
    return this._sb;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Entry point
  // ───────────────────────────────────────────────────────────────────────
  async scrape() {
    const sb = await this.getSupabase();
    const sources = await this.loadSources(sb);
    this.stats.sources = sources.length;
    if (sources.length === 0) {
      this.log('ℹ️ No active discovery sources; nothing to do.');
      return [];
    }
    this._proxyUrl = sources.some((s) => s.egress === 'residential') ? await residentialProxyUrl(sb) : null;
    if (sources.some((s) => s.egress === 'residential') && !this._proxyUrl) {
      this.log('⚠️ Sources request residential egress but the residential-egress module is not configured; fetching direct.');
    }
    await this.loadDedupeIndex(sb);

    const cutoff = new Date(Date.now() - this.opts.lookbackDays * DAY).toISOString();
    this.log(`🔎 Discovery sweep: ${sources.length} source(s), concurrency ${this.opts.concurrency}, lookback ${this.opts.lookbackDays}d, cutoff ${cutoff}`);

    // Phase 1: fetch every source, collect its entries (no writes yet, so the
    // guard can refuse the whole run before anything lands).
    const results = [];
    await runPool(sources, {
      concurrency: this.opts.concurrency,
      perKey: this.opts.perHost,
      keyOf: (s) => hostOf(s.feed_url || s.site_url),
      task: async (s) => {
        if (this.budgetLeft() < 0) {
          results.push({ source: s, status: 'skipped', reason: 'run budget spent' });
          return;
        }
        results.push(await this.fetchSource(s, cutoff));
      },
    });

    const alive = results.filter((r) => r.status === 'ok' || r.status === 'not_modified');
    const failed = results.filter((r) => r.status === 'failed');
    this.stats.alive = alive.length;
    this.stats.not_modified = results.filter((r) => r.status === 'not_modified').length;
    this.stats.failed = failed.length;
    const failureRate = failed.length / Math.max(results.length, 1);

    // Health is written on every outcome, including a tripped guard.
    await this.writeHealth(sb, results, { failureRate, guardTripped: alive.length === 0 && failed.length > 0 });

    if (alive.length === 0 && failed.length > 0) {
      const msg = `network dead, not a quiet week: 0 of ${results.length} sources answered and ${failed.length} failed; writing no posts`;
      this.log(`❌ ${msg}`);
      throw new Error(msg);
    }

    // Phase 1b: write posts.
    for (const r of results) {
      if (r.status !== 'ok') continue;
      for (const entry of r.entries) {
        if (this.budgetLeft() < 0) break;
        await this.upsertEntry(sb, r.source, entry, cutoff);
      }
    }

    // Phase 2: body backlog.
    if (this.opts.fetchFullContent && this.budgetLeft() > 60_000) {
      await this.fetchBodies(sb);
    } else if (this.opts.fetchFullContent) {
      this.log('⏱️ Run budget spent before the body phase; the backlog continues next run.');
    }

    this.log(this.summary(results));
    return [];
  }

  summary(results) {
    const s = this.stats;
    const lines = [
      `✅ Discovery sweep complete: ${s.sources} sources (${s.alive} alive, ${s.not_modified} unchanged, ${s.failed} failed)`,
      `   entries ${s.found} in window → ${s.inserted} new, ${s.updated} updated, ${s.owned_elsewhere} owned elsewhere, ${s.collapsed_url} url collapses, ${s.collapsed_title} title+date collapses, ${s.failed_items} failed`,
      `   bodies ${s.bodies_fetched} fetched, ${s.bodies_failed} failed; egress flips ${s.egress_flipped}`,
    ];
    const canaries = results.filter((r) => r.source.is_canary && r.status === 'ok' && r.entries.length === 0);
    if (canaries.length) lines.push(`   ⚠️ canary sources with no entries: ${canaries.map((c) => c.source.project).join(', ')}`);
    return lines.join('\n');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Sources
  // ───────────────────────────────────────────────────────────────────────
  async loadSources(sb) {
    const ids = Array.isArray(this.jobOptions.source_ids) ? this.jobOptions.source_ids.filter((x) => typeof x === 'string') : null;
    let q = sb.from('discovery_sources').select('*');
    q = ids && ids.length ? q.in('id', ids).neq('status', 'dead') : q.eq('status', 'active');
    const { data, error } = await q.order('foundation').order('project');
    if (error) throw new Error(`discovery_sources load failed: ${error.message}`);
    return data ?? [];
  }

  /** Fetch + parse one source. Never throws; returns a result record. */
  async fetchSource(source, cutoff) {
    const started = Date.now();
    const base = { source, elapsed_ms: 0, bytes: 0, entries: [], etag: null, lastModified: null, httpStatus: null, via: 'direct' };
    const proxyUrl = source.egress === 'residential' ? this._proxyUrl : null;
    try {
      if (source.kind === 'sitemap') {
        const r = await this.fetchSitemapSource(source, cutoff, proxyUrl);
        return { ...base, ...r, elapsed_ms: Date.now() - started };
      }
      if (!source.feed_url) return { ...base, status: 'failed', reason: 'no feed_url', elapsed_ms: Date.now() - started };
      const r = await fetchFeedConditional(source.feed_url, {
        etag: source.etag,
        lastModified: source.last_modified,
        // Full-content feeds run large (istio.io/feed.xml is over 5 MB); parsing is linear, so 15 MB is safe.
        maxBytes: 15 * 1024 * 1024,
        timeoutMs: this.opts.feedTimeoutMs,
        proxyUrl,
      });
      base.httpStatus = r.status;
      base.via = r.via;
      base.bytes = r.text.length;
      if (r.status === 304) return { ...base, status: 'not_modified', elapsed_ms: Date.now() - started };
      if (r.status !== 200) return { ...base, status: 'failed', reason: `status=${r.status}`, elapsed_ms: Date.now() - started };
      if (!looksLikeFeed(r.text)) return { ...base, status: 'failed', reason: 'not a feed (html or empty)', elapsed_ms: Date.now() - started };
      const feed = parseFeed(r.text, r.finalUrl || source.feed_url);
      if (feed.kind === 'unknown') return { ...base, status: 'failed', reason: 'unparseable feed', elapsed_ms: Date.now() - started };
      const entries = [];
      for (const e of feed.entries) {
        // Keep undated entries (stored with published_at null); drop dated ones outside the lookback.
        if (e.publishedAt && e.publishedAt < cutoff) { this.stats.out_of_window++; continue; }
        entries.push(e);
      }
      return { ...base, status: 'ok', entries, etag: r.etag, lastModified: r.lastModified, skipped: feed.skipped, elapsed_ms: Date.now() - started };
    } catch (e) {
      const reason = e instanceof FetchRefusedError ? `refused: ${e.message}` : (e?.name === 'AbortError' ? 'timeout' : scrubSecrets(e?.message ?? String(e), this._proxyUrl));
      return { ...base, status: 'failed', reason, elapsed_ms: Date.now() - started };
    }
  }

  /**
   * Sitemap kind: <lastmod> is only a candidate filter; the page's own date
   * is authoritative (a site-wide regeneration re-stamps every post). Pages
   * fetched per source per run are capped.
   */
  async fetchSitemapSource(source, cutoff, proxyUrl) {
    const sitemapUrl = source.feed_url;
    const prefix = source.path_prefix || '';
    if (!sitemapUrl) return { status: 'failed', reason: 'no sitemap url' };
    if (!prefix) return { status: 'failed', reason: 'sitemap source has no path_prefix' };
    const r = await fetchText(sitemapUrl, { timeoutMs: this.opts.feedTimeoutMs, proxyUrl });
    if (r.status !== 200 || !r.text) return { status: 'failed', reason: `status=${r.status}`, httpStatus: r.status };
    let { isIndex, entries } = parseSitemap(r.text);
    if (isIndex) {
      // Follow one level: the child sitemaps that could contain the prefix.
      const children = entries.slice(0, 10);
      entries = [];
      for (const child of children) {
        try {
          const cr = await fetchText(child.loc, { timeoutMs: this.opts.feedTimeoutMs, proxyUrl });
          if (cr.status === 200) entries.push(...parseSitemap(cr.text).entries);
        } catch { /* skip child */ }
      }
    }
    const prefixSlash = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '';
    const siteDomain = registrableDomain(hostOf(sitemapUrl));
    const candidates = entries
      .filter((u) => prefixSlash && u.loc.startsWith(prefixSlash) && u.loc !== prefixSlash)
      .filter((u) => registrableDomain(hostOf(u.loc)) === siteDomain)
      .filter((u) => u.lastmod && u.lastmod >= cutoff) // undated sitemap entries are unrankable
      .sort((a, b) => b.lastmod.localeCompare(a.lastmod))
      .slice(0, this.opts.sitemapPageCap);
    const out = [];
    for (const c of candidates) {
      if (this.budgetLeft() < 0) break;
      try {
        const page = await fetchText(c.loc, { maxBytes: PAGE_BYTES, timeoutMs: this.opts.pageTimeoutMs, proxyUrl });
        if (page.status !== 200) continue;
        const pub = publishedDate(page.text);
        if (pub && pub < cutoff) continue;
        const title = pageTitle(page.text) || c.loc.replace(/\/+$/, '').split('/').pop().replace(/[-_]+/g, ' ');
        out.push({
          title,
          link: c.loc,
          guid: null,
          publishedAt: pub ?? c.lastmod,
          updatedAt: c.lastmod,
          summary: pageDescription(page.text) ?? '',
          _pageHtml: page.text, // reuse in the body phase for this run only
        });
      } catch { /* one page failing is not a source failure */ }
    }
    return { status: 'ok', entries: out, httpStatus: 200, bytes: r.text.length, via: r.via };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Health + egress bookkeeping
  // ───────────────────────────────────────────────────────────────────────
  async writeHealth(sb, results, { failureRate, guardTripped }) {
    const now = new Date().toISOString();
    for (const r of results) {
      const s = r.source;
      const patch = { last_run_at: now };
      if (r.status === 'ok' || r.status === 'not_modified') {
        patch.last_ok_at = now;
        patch.last_error = null;
        patch.consecutive_failures = 0;
        if (r.etag) patch.etag = r.etag;
        if (r.lastModified) patch.last_modified = r.lastModified;
        const newest = (r.entries ?? []).map((e) => e.publishedAt).filter(Boolean).sort().at(-1);
        if (newest && (!s.last_entry_at || newest > s.last_entry_at)) patch.last_entry_at = newest;
      } else if (r.status === 'failed') {
        patch.last_error = scrubSecrets(r.reason ?? 'failed', this._proxyUrl);
        patch.consecutive_failures = (s.consecutive_failures ?? 0) + 1;
        // Egress auto-flip: two consecutive 403s, on a healthy run, on an unlocked direct source.
        const is403 = /status=403/.test(String(r.reason));
        const prev403 = /status=403/.test(String(s.last_error ?? ''));
        if (is403 && prev403 && s.egress === 'direct' && !s.egress_locked && !guardTripped && failureRate < 0.25) {
          patch.egress = 'residential';
          patch.egress_auto = true;
          this.stats.egress_flipped++;
          this.log(`🔁 ${s.project}: two consecutive 403s, switching to residential egress`);
        }
      } else {
        continue; // skipped for budget: leave untouched
      }
      const { error } = await sb.from('discovery_sources').update(patch).eq('id', s.id);
      if (error) this.log(`⚠️ health update failed for ${s.project}: ${error.message}`);
      this.log(JSON.stringify({ source_id: s.id, project: s.project, status: r.status, http: r.httpStatus ?? null, entries: r.entries?.length ?? 0, bytes: r.bytes ?? 0, elapsed_ms: r.elapsed_ms ?? 0, via: r.via ?? 'direct', error: r.reason ?? null }));
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Dedupe + write
  // ───────────────────────────────────────────────────────────────────────
  /** Recent external posts, for title+date collapse and ownership checks. */
  async loadDedupeIndex(sb) {
    const since = new Date(Date.now() - (this.opts.lookbackDays + 7) * DAY).toISOString();
    const byUrl = new Map();
    const byTitle = new Map(); // titleKey → [{day, id, source}]
    let from = 0;
    for (;;) {
      const { data, error } = await sb
        .from('blog_posts')
        .select('id, title, canonical_url, canonical_url_norm, published_at, discovery_source_id, status, excerpt')
        .eq('is_external', true)
        .or(`published_at.gte.${since},published_at.is.null`)
        .order('created_at', { ascending: false })
        .range(from, from + 999);
      if (error) throw new Error(`dedupe index load failed: ${error.message}`);
      for (const row of data ?? []) {
        if (row.canonical_url_norm) byUrl.set(row.canonical_url_norm, row);
        const tk = titleKey(row.title);
        if (tk) {
          if (!byTitle.has(tk)) byTitle.set(tk, []);
          byTitle.get(tk).push({ day: dayOf(row.published_at), id: row.id, source: row.discovery_source_id });
        }
      }
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    this._index = { byUrl, byTitle };
  }

  async upsertEntry(sb, source, entry, cutoff) {
    const canonical = canonicalForStorage(entry.link);
    if (!canonical) { this.stats.skipped++; return; }
    const norm = normalizeUrl(canonical);
    this.stats.found++;
    try {
      // Pass 1: same normalised URL.
      let existing = this._index.byUrl.get(norm) ?? null;
      if (!existing) {
        const { data } = await sb.from('blog_posts').select('id, title, canonical_url, canonical_url_norm, published_at, discovery_source_id, status, excerpt').eq('canonical_url_norm', norm).maybeSingle();
        existing = data ?? null;
      }
      if (existing) {
        if (!existing.discovery_source_id) {
          this.stats.owned_elsewhere++;
          return; // owned by another scraper or a human: never touched
        }
        if (existing.discovery_source_id !== source.id) {
          // Syndicated: another source already landed this URL. Count the
          // collapse; never let one feed rewrite a post another feed owns.
          this.stats.collapsed_url++;
          return;
        }
        if (existing.status !== 'pending_review') { this.stats.skipped++; return; } // rejected or published: a human decided
        const patch = {
          title: entry.title.slice(0, 500),
          source_updated_at: entry.updatedAt ?? null,
          updated_at: new Date().toISOString(),
        };
        if (!existing.excerpt && entry.summary) patch.excerpt = excerptForStorage(entry.summary);
        if (!existing.published_at && entry.publishedAt) patch.published_at = entry.publishedAt;
        const { error } = await sb.from('blog_posts').update(patch).eq('id', existing.id);
        if (error) throw new Error(error.message);
        this.stats.updated++;
        this.stats.collapsed_url++;
        return;
      }

      // Pass 2: same title, same day ± 1, under a different source.
      const tk = titleKey(entry.title);
      const d = dayOf(entry.publishedAt);
      if (tk && d !== null) {
        const hit = (this._index.byTitle.get(tk) ?? []).find((h) => h.day !== null && Math.abs(h.day - d) <= 1 && h.source !== source.id);
        if (hit) {
          this.stats.collapsed_title++;
          this.log(`↪ collapsed same title+date: "${entry.title}" (${source.project}) → existing ${hit.id}`);
          return;
        }
      }

      const row = {
        title: entry.title.slice(0, 500),
        slug: slugForPost(canonical),
        excerpt: entry.summary ? excerptForStorage(entry.summary) : null,
        content: null,
        canonical_url: canonical,
        is_external: true,
        visibility: 'public',
        status: 'pending_review',
        publish_state: 'pending_review',
        published_at: entry.publishedAt ?? null,
        source_updated_at: entry.updatedAt ?? null,
        author_id: SYSTEM_AUTHOR_ID,
        content_category: source.content_category || this.config.content_category || 'ecosystem',
        discovery_source_id: source.id,
        meta_title: entry.title.slice(0, 255),
        meta_description: entry.summary ? excerptForStorage(entry.summary, 300) : null,
      };
      let inserted = await sb.from('blog_posts').insert(row).select('id').maybeSingle();
      if (inserted.error && inserted.error.code === '23505') {
        if (/slug/.test(inserted.error.message)) {
          // residual slug collision: retry once with the hash suffix
          inserted = await sb.from('blog_posts').insert({ ...row, slug: `${row.slug.slice(0, 470)}-${shortHash(norm)}` }).select('id').maybeSingle();
        } else {
          // concurrent duplicate on canonical_url_norm: treat as collapse
          this.stats.collapsed_url++;
          return;
        }
      }
      if (inserted.error) throw new Error(inserted.error.message);
      const postId = inserted.data?.id;
      this.stats.inserted++;
      this.stats.processed++;
      this._index.byUrl.set(norm, { id: postId, discovery_source_id: source.id, status: 'pending_review', published_at: row.published_at, content: null, excerpt: row.excerpt });
      if (tk) {
        if (!this._index.byTitle.has(tk)) this._index.byTitle.set(tk, []);
        this._index.byTitle.get(tk).push({ day: d, id: postId, source: source.id });
      }
      if (entry._pageHtml) this._pageCache = Object.assign(this._pageCache ?? new Map(), { [postId]: entry._pageHtml });

      // Provenance for the Inbox. Non-fatal.
      try {
        const { error } = await sb.rpc('record_content_source', {
          p_content_type: 'blog_post',
          p_content_id: postId,
          p_source_kind: 'scraper',
          p_source_ref: `discovery:${source.id}`,
          p_source_meta: { foundation: source.foundation, project: source.project, scraper_id: this.config.id ?? null, feed_url: source.feed_url },
        });
        if (error) this.log(`⚠️ record_content_source failed (non-fatal): ${error.message}`);
      } catch (e) {
        this.log(`⚠️ record_content_source threw (non-fatal): ${e?.message ?? e}`);
      }
      this.log(`✅ Saved: ${entry.title} (${source.project})`);
    } catch (e) {
      this.stats.failed_items++;
      this.log(`❌ Failed "${entry.title}" (${source.project}): ${e?.message ?? e}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Body backlog
  // ───────────────────────────────────────────────────────────────────────
  async fetchBodies(sb) {
    const { data: posts, error } = await sb
      .from('blog_posts')
      .select('id, canonical_url, excerpt, discovery_source_id, body_fetch_attempts, discovery_sources!inner(egress)')
      .eq('is_external', true)
      .not('discovery_source_id', 'is', null)
      .is('content', null)
      .lt('body_fetch_attempts', 3)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(this.opts.bodyFetchCap);
    if (error) { this.log(`⚠️ body backlog query failed: ${error.message}`); return; }
    if (!posts?.length) return;
    this.log(`📄 Body backlog: ${posts.length} post(s)`);
    const perHostCount = new Map();
    await runPool(posts, {
      concurrency: Math.min(this.opts.concurrency, 8),
      perKey: this.opts.perHost,
      keyOf: (p) => hostOf(p.canonical_url),
      task: async (p) => {
        if (this.budgetLeft() < 0) return;
        const host = hostOf(p.canonical_url);
        const n = perHostCount.get(host) ?? 0;
        if (n >= 20) return; // per host per run
        perHostCount.set(host, n + 1);
        const proxyUrl = p.discovery_sources?.egress === 'residential' ? this._proxyUrl : null;
        const patch = { body_fetch_attempts: (p.body_fetch_attempts ?? 0) + 1 };
        try {
          const html = this._pageCache?.[p.id] ?? (await fetchText(p.canonical_url, { maxBytes: PAGE_BYTES, timeoutMs: this.opts.pageTimeoutMs, proxyUrl })).text;
          if (!html) throw new Error('empty page');
          const body = articleBody(html);
          const clean = body ? await sanitizeBody(body) : '';
          if (clean === null) {
            // sanitiser missing on this worker: leave the body for a worker that has it
            delete patch.body_fetch_attempts;
            this.stats.bodies_failed++;
            if (!p.excerpt) { const d = pageDescription(html); if (d) patch.excerpt = excerptForStorage(d); }
            if (Object.keys(patch).length) await sb.from('blog_posts').update(patch).eq('id', p.id);
            return;
          }
          if (clean) patch.content = clean;
          if (!p.excerpt) {
            const desc = pageDescription(html);
            if (desc) patch.excerpt = excerptForStorage(desc);
          }
          const canon = canonicalLink(html, p.canonical_url);
          if (canon && normalizeUrl(canon) !== normalizeUrl(p.canonical_url)) {
            // The page says it is syndicated from elsewhere. Logged, not acted on (spec §4.3 pass 1 alias is a follow-up).
            this.log(`↪ rel=canonical differs for ${p.canonical_url} → ${canon}`);
          }
          if (clean) this.stats.bodies_fetched++;
          else this.stats.bodies_failed++;
        } catch (e) {
          this.stats.bodies_failed++;
          this.log(`⚠️ body fetch failed for ${p.canonical_url}: ${e?.message ?? e}`);
        }
        const { error: upErr } = await sb.from('blog_posts').update(patch).eq('id', p.id);
        if (upErr) this.log(`⚠️ body update failed for ${p.id}: ${upErr.message}`);
      },
    });
  }
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export default FeedScraper;
