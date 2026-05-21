#!/usr/bin/env node
/**
 * Stdio MCP server exposing Gatewaze-unique web tools to Goose.
 *
 * Currently provides one tool: `gatewaze_search` — Serper.dev with a
 * DuckDuckGo fallback. The platform spawns this server whenever a
 * use case has `gatewaze_search` in its allowed_web_tools list.
 *
 * Why this server doesn't expose web_search / fetch_url:
 *   - Anthropic ships `web_search` as a native server-side tool, so
 *     Claude-backed recipes get it for free via the model.
 *   - Goose's `developer` builtin handles basic URL fetches. Recipes
 *     that need it can `--with-builtin developer` or declare a
 *     dedicated fetch MCP server.
 *
 * The Gatewaze MCP's role is the Serper.dev + DDG fallback chain —
 * uniform across providers, operator-controllable, ledgered.
 *
 * Goose tool surface: gatewaze-web-tools__gatewaze_search.
 *
 * ## Two operating modes
 *
 * **Platform mode** — spawned by run-recipe-goose / run-chat-goose
 * inside the Gatewaze worker. The wrapper sets
 * GATEWAZE_ALLOWED_WEB_TOOLS to a comma-separated subset (only
 * `gatewaze_search` is meaningful here since that's the only tool we
 * advertise); tools/list is filtered accordingly.
 *
 * **Local Goose mode** — anyone running `goose run --recipe foo.yaml`
 * on their own machine. With GATEWAZE_ALLOWED_WEB_TOOLS unset, the
 * full tool surface (currently just `gatewaze_search`) is exposed.
 *
 * Backend selection for the DuckDuckGo fallback, highest priority
 * first:
 *
 *   1. GATEWAZE_FETCH_BASE_URL + GATEWAZE_FETCH_API_KEY
 *        → public gatewaze-fetch service (paid, anti-bot + JS render)
 *   2. SCRAPLING_FETCHER_URL + SCRAPLING_INTERNAL_TOKEN
 *        → in-cluster scrapling-fetcher (Gatewaze internal)
 *   3. (no env set) → vanilla node fetch() — works for most public
 *      pages without any external service
 *
 * Serper.dev is preferred when SERPER_API_KEY is set; otherwise the
 * server falls back to scraping DuckDuckGo's HTML endpoint via the
 * active fetch backend.
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
 *         SERPER_API_KEY: "${SERPER_API_KEY}"
 *
 * ## Standalone debug
 *
 *   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
 *     | node gatewaze-web-tools-mcp.mjs
 */

import { createInterface } from 'node:readline';
import process from 'node:process';

const ALL_TOOL_NAMES = ['gatewaze_search'];

// Platform mode (env set to a non-empty list) → exactly that subset.
// Local mode (env unset or empty) → expose ALL tools. The platform
// wrapper at run-recipe-goose.ts always passes the env var so platform
// spawns never accidentally expose tools the operator didn't allow.
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

function fetchBackend() {
  if (GATEWAZE_FETCH_URL && GATEWAZE_FETCH_KEY) return 'gatewaze-fetch';
  if (SCRAPLING_URL && SCRAPLING_TOKEN) return 'scrapling';
  return 'vanilla';
}

// ─── unified fetch backend ───────────────────────────────────────
async function htmlFetch(url) {
  const backend = fetchBackend();
  if (backend === 'gatewaze-fetch') return gatewazeFetch(url);
  if (backend === 'scrapling') return scraplingFetch(url);
  return vanillaFetch(url);
}

async function scraplingFetch(url) {
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
        mode: 'fast',
        extract: ['html'],
        timeout_ms: FETCH_TIMEOUT_MS - 1000,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`scrapling ${response.status}: ${text.slice(0, 400)}`);
    }
    const body = await response.json();
    return { html: typeof body.html === 'string' ? body.html : '' };
  } finally {
    clearTimeout(timer);
  }
}

async function gatewazeFetch(url) {
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
        mode: 'fast',
        extract: ['html'],
        timeout_ms: FETCH_TIMEOUT_MS - 1000,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`gatewaze-fetch ${response.status}: ${text.slice(0, 400)}`);
    }
    const body = await response.json();
    return { html: typeof body.html === 'string' ? body.html : '' };
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
        'User-Agent': 'Mozilla/5.0 (gatewaze-web-tools-mcp; +https://example.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const html = await response.text();
    return { html };
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

// ─── DuckDuckGo HTML scrape ──────────────────────────────────────
function parseDdgHtml(html, maxResults) {
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
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function queryDdg(query, maxResults) {
  const ddgUrl = `${DDG_HTML_ENDPOINT}?${new URLSearchParams({ q: query }).toString()}`;
  const body = await htmlFetch(ddgUrl);
  const html = body.html ?? '';
  if (!html) throw new Error('fetch backend returned empty html');
  return parseDdgHtml(html, maxResults);
}

// ─── tool implementations ────────────────────────────────────────
function pickSearchBackend() {
  if (SEARCH_BACKEND_OVERRIDE === 'serper') return 'serper';
  if (SEARCH_BACKEND_OVERRIDE === 'ddg') return 'ddg';
  return SERPER_KEY ? 'serper' : 'ddg';
}

async function gatewazeSearch({ query, max_results = 6 }) {
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

// ─── MCP JSON-RPC handler ────────────────────────────────────────
const TOOL_DEFINITIONS = {
  gatewaze_search: {
    name: 'gatewaze_search',
    description: 'Search the web. Uses Serper.dev when SERPER_API_KEY is configured (Google results, ~$1/1k queries); falls back to scraping DuckDuckGo HTML otherwise. Returns a ranked list of {title, url, snippet}.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number', minimum: 1, maximum: 20, default: 6 },
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
        case 'gatewaze_search': result = await gatewazeSearch(args); break;
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
