#!/usr/bin/env node
/**
 * Bridges Gatewaze's `allowed_web_tools` surface (web_search,
 * fetch_url, gatewaze_search) into Goose as a stdio MCP extension.
 * Goose calls the tools as gatewaze-web-tools__web_search /
 * __fetch_url / __gatewaze_search.
 *
 * ## What this MCP is (and isn't) for
 *
 * `web_search` and `fetch_url` are often already available from
 * other sources — Anthropic's API exposes `web_search` as a native
 * server-side tool, and Goose's `developer` builtin can fetch URLs.
 * Recipes targeting those providers can use the native paths and
 * skip this MCP entirely.
 *
 * The Gatewaze MCP's unique value:
 *   - `gatewaze_search` — Serper.dev with DDG fallback, no native
 *      equivalent on any provider
 *   - **Provider parity** — gives OpenAI/Gemini-backed recipes the
 *      same web_search/fetch_url surface Anthropic gets natively
 *   - **Cost ledger** (platform mode only) — every call lands as
 *      one ai_usage_events row, attributable per use case
 *
 * ## Two operating modes
 *
 * **Platform mode** — spawned by run-recipe-goose / run-chat-goose
 * inside the Gatewaze worker. The wrapper sets
 * GATEWAZE_ALLOWED_WEB_TOOLS to the use case's allowed_web_tools
 * subset; the tools/list response is filtered strictly to that set.
 *
 * **Local Goose mode** — anyone running `goose run --recipe foo.yaml`
 * on their own machine. With GATEWAZE_ALLOWED_WEB_TOOLS unset, ALL
 * three tools are advertised so developers can experiment freely.
 * Set the env to a subset to mirror a specific use case's allowlist
 * during development.
 *
 * Backend selection (fetch_url + DDG html scrape), highest priority
 * first:
 *
 *   1. GATEWAZE_FETCH_BASE_URL + GATEWAZE_FETCH_API_KEY
 *        → public gatewaze-fetch service (paid, anti-bot + JS render)
 *   2. SCRAPLING_FETCHER_URL + SCRAPLING_INTERNAL_TOKEN
 *        → in-cluster scrapling-fetcher (Gatewaze internal)
 *   3. (no env set) → vanilla node fetch() (no JS, no anti-bot —
 *        works for most public pages)
 *
 * web_search picks Serper.dev when SERPER_API_KEY is set, else
 * falls back to DuckDuckGo HTML scrape via the active fetch backend.
 *
 * ## Recipe.yaml example (local Goose)
 *
 *   extensions:
 *     - type: stdio
 *       name: gatewaze-web-tools
 *       cmd: node
 *       args:
 *         - /path/to/gatewaze-web-tools-mcp.mjs
 *       envs:
 *         # Omit to expose all three tools (default). Set to a
 *         # subset to mirror a specific use case's allowlist during
 *         # development.
 *         # GATEWAZE_ALLOWED_WEB_TOOLS: "gatewaze_search"
 *         SERPER_API_KEY: "${SERPER_API_KEY}"
 *         # Optional public fetch backend:
 *         # GATEWAZE_FETCH_BASE_URL: "https://fetch.example.com"
 *         # GATEWAZE_FETCH_API_KEY: "${GATEWAZE_FETCH_API_KEY}"
 *
 * ## Standalone debug
 *
 *   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
 *     | node gatewaze-web-tools-mcp.mjs
 */

import { createInterface } from 'node:readline';
import process from 'node:process';

const ALL_TOOL_NAMES = ['web_search', 'fetch_url', 'gatewaze_search'];

// Platform mode (env set to a non-empty list) → exactly that subset.
// Local mode (env unset or empty) → expose ALL tools so a developer
// building a recipe locally can use everything without first wiring
// a use-case allowlist. The platform wrapper at run-recipe-goose.ts
// always passes the env var so platform spawns never accidentally
// expose disabled tools.
const rawAllowed = (process.env.GATEWAZE_ALLOWED_WEB_TOOLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED = new Set(rawAllowed.length > 0 ? rawAllowed : ALL_TOOL_NAMES);

const SCRAPLING_URL = process.env.SCRAPLING_FETCHER_URL;
const SCRAPLING_TOKEN = process.env.SCRAPLING_INTERNAL_TOKEN;
const GATEWAZE_FETCH_URL = process.env.GATEWAZE_FETCH_BASE_URL;
const GATEWAZE_FETCH_KEY = process.env.GATEWAZE_FETCH_API_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;
const SEARCH_BACKEND_OVERRIDE = process.env.GATEWAZE_SEARCH_BACKEND; // 'auto'|'serper'|'ddg'

const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html';
const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const FETCH_TIMEOUT_MS = 15_000;
const SERPER_TIMEOUT_MS = 12_000;

// Backend selection for fetch_url + DDG html scraping. Highest
// priority first:
//   1. gatewaze-fetch (public paid service)
//   2. scrapling-fetcher (in-cluster)
//   3. vanilla node fetch (no anti-bot, no JS) — works for most
//      public pages without any external service
function fetchBackend() {
  if (GATEWAZE_FETCH_URL && GATEWAZE_FETCH_KEY) return 'gatewaze-fetch';
  if (SCRAPLING_URL && SCRAPLING_TOKEN) return 'scrapling';
  return 'vanilla';
}

// ─── unified fetch backend ───────────────────────────────────────
// Returns { url, final_url, status, html, text, mode_used } regardless
// of which backend serviced the call. text is best-effort: scrapling
// + gatewaze-fetch return it directly; vanilla mode strips tags from
// html with a minimal regex.
async function htmlFetch(url, { mode = 'fast' } = {}) {
  const backend = fetchBackend();
  if (backend === 'gatewaze-fetch') {
    return gatewazeFetch(url, { mode });
  }
  if (backend === 'scrapling') {
    return scraplingFetch(url, { mode });
  }
  return vanillaFetch(url);
}

async function scraplingFetch(url, { mode = 'fast' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${SCRAPLING_URL.replace(/\/$/, '')}/fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': SCRAPLING_TOKEN,
      },
      body: JSON.stringify({
        url,
        mode,
        extract: ['html', 'text'],
        timeout_ms: FETCH_TIMEOUT_MS - 1000,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`scrapling ${response.status}: ${text.slice(0, 400)}`);
    }
    const body = await response.json();
    return {
      url,
      final_url: typeof body.final_url === 'string' ? body.final_url : url,
      status: typeof body.status === 'number' ? body.status : 200,
      html: typeof body.html === 'string' ? body.html : '',
      text: typeof body.text === 'string' ? body.text : '',
      mode_used: mode,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function gatewazeFetch(url, { mode = 'fast' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${GATEWAZE_FETCH_URL.replace(/\/$/, '')}/v1/fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAZE_FETCH_KEY}`,
      },
      body: JSON.stringify({
        url,
        mode,
        extract: ['html', 'text'],
        timeout_ms: FETCH_TIMEOUT_MS - 1000,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`gatewaze-fetch ${response.status}: ${text.slice(0, 400)}`);
    }
    const body = await response.json();
    return {
      url,
      final_url: typeof body.final_url === 'string' ? body.final_url : url,
      status: typeof body.status === 'number' ? body.status : 200,
      html: typeof body.html === 'string' ? body.html : '',
      text: typeof body.text === 'string' ? body.text : '',
      mode_used: mode,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function vanillaFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        // Generic UA — many sites refuse fetches without one.
        'User-Agent': 'Mozilla/5.0 (gatewaze-web-tools-mcp; +https://example.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const html = await response.text();
    return {
      url,
      final_url: response.url,
      status: response.status,
      html,
      text: stripTags(html),
      mode_used: 'vanilla',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Serper ──────────────────────────────────────────────────────
async function querySerper(query, maxResults) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);
  try {
    const response = await fetch(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': SERPER_KEY,
      },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`serper ${response.status}: ${text.slice(0, 400)}`);
    }
    const body = await response.json();
    const organic = body.organic ?? [];
    return organic
      .slice(0, maxResults)
      .filter((r) => typeof r.title === 'string' && typeof r.link === 'string')
      .map((r) => ({
        title: r.title,
        url: r.link,
        snippet: typeof r.snippet === 'string' ? r.snippet : '',
      }));
  } finally {
    clearTimeout(timer);
  }
}

// ─── DuckDuckGo HTML scrape (same parser as lib/gatewaze-search.ts) ──
function parseDdgHtml(html, maxResults) {
  // Minimal HTML scrape: pick <a class="result__a" href="...">title</a>
  // followed by <a class="result__snippet">snippet</a>. DDG's HTML
  // endpoint is stable enough for this to survive without a parser.
  const out = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const titles = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && titles.length < maxResults * 2) {
    titles.push({ rawUrl: m[1], title: stripTags(m[2]).trim() });
  }
  const snippets = [];
  while ((m = snipRe.exec(html)) !== null && snippets.length < titles.length) {
    snippets.push(stripTags(m[1]).trim());
  }
  for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
    const t = titles[i];
    // DDG wraps the real URL in a redirector: /l/?uddg=<encoded>
    let url = t.rawUrl;
    try {
      if (url.startsWith('//')) url = `https:${url}`;
      const u = new URL(url, 'https://duckduckgo.com');
      if (u.searchParams.has('uddg')) url = u.searchParams.get('uddg');
    } catch {/* leave url as-is */}
    out.push({
      title: t.title,
      url,
      snippet: snippets[i] ?? '',
    });
  }
  return out;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function queryDdg(query, maxResults) {
  const ddgUrl = `${DDG_HTML_ENDPOINT}?${new URLSearchParams({ q: query }).toString()}`;
  const body = await htmlFetch(ddgUrl, { mode: 'fast' });
  const html = body.html ?? '';
  if (!html) throw new Error(`${body.mode_used} fetch returned empty html`);
  return parseDdgHtml(html, maxResults);
}

// ─── tool implementations ────────────────────────────────────────
function pickSearchBackend() {
  if (SEARCH_BACKEND_OVERRIDE === 'serper') return 'serper';
  if (SEARCH_BACKEND_OVERRIDE === 'ddg') return 'ddg';
  return SERPER_KEY ? 'serper' : 'ddg';
}

async function webSearch({ query, max_results = 6 }) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('query (string) required');
  }
  const cap = Math.max(1, Math.min(20, Number(max_results) || 6));
  const backend = pickSearchBackend();
  const results = backend === 'serper'
    ? await querySerper(query, cap)
    : await queryDdg(query, cap);
  return { backend, query, results };
}

// Identical semantics to web_search — Anthropic's native web_search
// and Gatewaze's `gatewaze_search` collapse onto the same backend
// from Goose's POV. We expose both names so a recipe written against
// either contract picks the right tool by suffix.
const gatewazeSearch = webSearch;

async function fetchUrl({ url, mode = 'fast' }) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('url (string) required');
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('malformed url'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`only http/https URLs allowed (got ${parsed.protocol})`);
  }
  const validMode = ['fast', 'stealth', 'browser'].includes(mode) ? mode : 'fast';
  const body = await scraplingFetch(url, { mode: validMode, extract: ['html', 'text'] });
  return {
    url,
    final_url: typeof body.final_url === 'string' ? body.final_url : url,
    status: typeof body.status === 'number' ? body.status : 200,
    mode_used: validMode,
    text: typeof body.text === 'string' ? body.text : '',
    html: typeof body.html === 'string' ? body.html.slice(0, 200_000) : '',
  };
}

// ─── MCP JSON-RPC handler ────────────────────────────────────────
const TOOL_DEFINITIONS = {
  web_search: {
    name: 'web_search',
    description: 'Search the web via Serper.dev (when SERPER_API_KEY is configured) or DuckDuckGo as a fallback. Returns a ranked list of {title, url, snippet}.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number', minimum: 1, maximum: 20, default: 6 },
      },
    },
  },
  gatewaze_search: {
    name: 'gatewaze_search',
    description: 'Same as web_search — provided under both names so recipes can reference whichever surface they were written against.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number', minimum: 1, maximum: 20, default: 6 },
      },
    },
  },
  fetch_url: {
    name: 'fetch_url',
    description: 'Fetch the contents of a URL via gatewaze scrapling-fetcher and return its extracted text + html. Supports modes: fast (HTTP, no JS), stealth (header-jiggled HTTP), browser (full Chromium). Default fast.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        mode: { type: 'string', enum: ['fast', 'stealth', 'browser'], default: 'fast' },
      },
    },
  },
};

function activeTools() {
  return Array.from(ALLOWED)
    .filter((name) => TOOL_DEFINITIONS[name])
    .map((name) => TOOL_DEFINITIONS[name]);
}

function sendResponse(id, result, error) {
  const msg = error
    ? { jsonrpc: '2.0', id, error }
    : { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'gatewaze-web-tools', version: '1.0.0' },
      });
      return;
    }
    if (method === 'tools/list') {
      sendResponse(id, { tools: activeTools() });
      return;
    }
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      if (!ALLOWED.has(name)) {
        sendResponse(id, null, { code: -32601, message: `Tool '${name}' not in allowed list` });
        return;
      }
      let result;
      switch (name) {
        case 'web_search':      result = await webSearch(args); break;
        case 'gatewaze_search': result = await gatewazeSearch(args); break;
        case 'fetch_url':       result = await fetchUrl(args); break;
        default:
          sendResponse(id, null, { code: -32601, message: `Unknown tool: ${name}` });
          return;
      }
      sendResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: false,
      });
      return;
    }
    if (id != null) {
      sendResponse(id, null, { code: -32601, message: `Unknown method: ${method}` });
    }
  } catch (err) {
    if (id != null) {
      sendResponse(id, null, { code: -32000, message: err instanceof Error ? err.message : String(err) });
    } else {
      process.stderr.write(`gatewaze-web-tools-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`gatewaze-web-tools-mcp: non-JSON line dropped: ${trimmed.slice(0, 200)}\n`);
    return;
  }
  void handleMessage(msg);
});
rl.on('close', () => process.exit(0));
