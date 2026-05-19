/**
 * Internal model-agnostic web search.
 *
 * Exposed to every provider (Anthropic, OpenAI, Gemini) as a function-
 * call tool named `gatewaze_search`. The model invokes it with a query
 * and we route to one of two backends:
 *
 *   - **Serper.dev** — Google-results JSON API. Used when SERPER_API_KEY
 *     is set (and GATEWAZE_SEARCH_BACKEND isn't forcing 'ddg'). Stable,
 *     well-ranked, paid (~$1/1k after a free 2,500-search trial).
 *   - **DuckDuckGo HTML** — scraped via scrapling-fetcher's anti-bot
 *     stealth fetch. Free, no key required, but markup occasionally
 *     drifts and DDG sometimes serves a challenge page. Default
 *     fallback when no Serper key is configured.
 *
 * Backend selection (priority order):
 *   1. GATEWAZE_SEARCH_BACKEND=serper|ddg explicitly forces one.
 *   2. SERPER_API_KEY set → serper.
 *   3. Otherwise → ddg.
 *
 * The caller never has to know which backend ran; they receive a
 * uniform `{ ok, results, backend }` envelope. The `backend` field is
 * included so the runner can log it for cost/observability without
 * the model seeing it.
 */

import type { GatewazeSearchResult } from './providers/types.js';

const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const DDG_HTML_ENDPOINT = 'https://duckduckgo.com/html/';
const DEFAULT_MAX_RESULTS = 6;
const HARD_MAX_RESULTS = 20;
const SERPER_TIMEOUT_MS = 12_000;
const DDG_TIMEOUT_MS = 20_000;

export interface BuildSearchResolverOpts {
  /** Serper.dev API key. When absent, the resolver falls back to DDG. */
  serperApiKey?: string;
  /**
   * Backend override. 'auto' (default) picks serper when a key is set,
   * else ddg. 'serper' forces serper (errors if no key). 'ddg' forces
   * ddg even if a serper key exists — useful for testing the free
   * path on demand.
   */
  backend?: 'auto' | 'serper' | 'ddg';
  /**
   * Scrapling-fetcher endpoint. Required when the resolver may fall
   * back to DDG (the HTML scrape goes through scrapling for anti-bot
   * stealth). If unset and DDG is needed, the resolver returns an error
   * envelope so the model can degrade gracefully.
   */
  scraplingFetcherUrl?: string;
  scraplingInternalToken?: string;
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

export interface SearchResolverResult {
  ok: boolean;
  results: GatewazeSearchResult[];
  backend: 'serper' | 'ddg';
  error?: string;
}

/**
 * Build a `resolveGatewazeSearch(query, max)` callback ready to plug
 * into the AI runner. The caller is expected to thread this through
 * RunConversationOpts.resolveGatewazeSearch.
 */
export function buildGatewazeSearchResolver(
  opts: BuildSearchResolverOpts,
): (query: string, maxResults: number) => Promise<SearchResolverResult> {
  const requested = opts.backend ?? 'auto';
  const hasSerper = Boolean(opts.serperApiKey);
  const effectiveBackend: 'serper' | 'ddg' =
    requested === 'serper'
      ? 'serper'
      : requested === 'ddg'
        ? 'ddg'
        : hasSerper
          ? 'serper'
          : 'ddg';

  if (effectiveBackend === 'serper' && !hasSerper) {
    return async () => ({
      ok: false,
      results: [],
      backend: 'serper',
      error: 'SERPER_API_KEY not configured; cannot use forced serper backend',
    });
  }

  return async (query: string, maxResults: number): Promise<SearchResolverResult> => {
    const max = clampMaxResults(maxResults);
    const q = (query ?? '').trim();
    if (!q) {
      return { ok: false, results: [], backend: effectiveBackend, error: 'empty query' };
    }

    if (effectiveBackend === 'serper') {
      try {
        const results = await querySerper(q, max, opts.serperApiKey!);
        return { ok: true, results, backend: 'serper' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger?.warn?.('gatewaze_search.serper.failed', { query: q, error: message });
        return { ok: false, results: [], backend: 'serper', error: message };
      }
    }

    // DDG path.
    if (!opts.scraplingFetcherUrl || !opts.scraplingInternalToken) {
      return {
        ok: false,
        results: [],
        backend: 'ddg',
        error: 'SCRAPLING_FETCHER_URL / SCRAPLING_INTERNAL_TOKEN not configured',
      };
    }
    try {
      const results = await queryDdg(q, max, {
        scraplingFetcherUrl: opts.scraplingFetcherUrl,
        scraplingInternalToken: opts.scraplingInternalToken,
      });
      return { ok: true, results, backend: 'ddg' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger?.warn?.('gatewaze_search.ddg.failed', { query: q, error: message });
      return { ok: false, results: [], backend: 'ddg', error: message };
    }
  };
}

// ─── Serper ────────────────────────────────────────────────────────────────

interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
}

async function querySerper(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<GatewazeSearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);
  try {
    const response = await fetch(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`serper ${response.status}: ${text.slice(0, 400)}`);
    }
    const body = (await response.json()) as SerperResponse;
    const organic = body.organic ?? [];
    return organic
      .slice(0, maxResults)
      .filter((r) => typeof r.title === 'string' && typeof r.link === 'string')
      .map((r) => ({
        title: r.title!,
        url: r.link!,
        snippet: typeof r.snippet === 'string' ? r.snippet : '',
      }));
  } finally {
    clearTimeout(timer);
  }
}

// ─── DuckDuckGo HTML scrape ────────────────────────────────────────────────

async function queryDdg(
  query: string,
  maxResults: number,
  opts: { scraplingFetcherUrl: string; scraplingInternalToken: string },
): Promise<GatewazeSearchResult[]> {
  const ddgUrl = `${DDG_HTML_ENDPOINT}?${new URLSearchParams({ q: query }).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DDG_TIMEOUT_MS);
  try {
    const response = await fetch(`${opts.scraplingFetcherUrl.replace(/\/$/, '')}/fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': opts.scraplingInternalToken,
      },
      body: JSON.stringify({
        url: ddgUrl,
        mode: 'fast',
        extract: ['html'],
        timeout_ms: DDG_TIMEOUT_MS - 1000,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`scrapling ${response.status}: ${text.slice(0, 400)}`);
    }
    const body = (await response.json()) as { html?: string };
    const html = body.html ?? '';
    if (!html) {
      throw new Error('scrapling returned empty html');
    }
    return parseDdgHtml(html, maxResults);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse DuckDuckGo's /html/ result page. The markup uses a stable
 * `.result` block container with nested `.result__title > a` (URL +
 * title) and `.result__snippet`. The URL on the anchor is wrapped
 * through DDG's /l/?uddg= redirect — we decode the `uddg` param to
 * recover the real destination.
 *
 * If DDG drifts to a new template (it has roughly once a year), the
 * regex selectors here are the only place that needs updating.
 */
export function parseDdgHtml(html: string, maxResults: number): GatewazeSearchResult[] {
  const out: GatewazeSearchResult[] = [];
  // Match each result block — non-greedy across the container.
  const blockRe = /<div class="result[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(html)) !== null) {
    if (out.length >= maxResults) break;
    const block = blockMatch[1] ?? '';
    const titleMatch = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
      block,
    );
    if (!titleMatch) continue;
    const rawHref = titleMatch[1] ?? '';
    const titleHtml = titleMatch[2] ?? '';
    const url = decodeDdgRedirect(rawHref);
    if (!url) continue;
    const title = stripTags(titleHtml).trim();
    const snippetMatch = /<a[^>]*class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const snippet = snippetMatch ? stripTags(snippetMatch[1] ?? '').trim() : '';
    if (!title || !url) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

function decodeDdgRedirect(href: string): string {
  if (!href) return '';
  // DDG result anchors usually look like //duckduckgo.com/l/?uddg=<urlencoded>&rut=...
  // Newer pages occasionally inline the URL directly — handle both.
  if (/^https?:\/\//i.test(href)) return href;
  try {
    const absolute = href.startsWith('//') ? `https:${href}` : `https://duckduckgo.com${href}`;
    const u = new URL(absolute);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return '';
  } catch {
    return '';
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function clampMaxResults(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(n), HARD_MAX_RESULTS);
}
