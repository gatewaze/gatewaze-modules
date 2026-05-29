#!/usr/bin/env node
// gatewaze-wiki-mcp — spec-ai-memory-wiki.md §5.1, §5.8.
//
// Stdio JSON-RPC MCP server exposing the wiki tool surface. Substituted into
// Goose when a use case allowlists the `wiki` extension. This is a thin
// stdio→HTTP adapter: every tool call hits the AI module's /internal/wiki/*
// endpoints (authenticated by the service-role key), so all logic — content
// hashing, link extraction, embedding (cost-tracked via aiEmbed), hybrid
// search — runs server-side over the shared repository. No DB logic is
// duplicated here. (The local Goose backend, phase 6, is a separate variant.)
//
// Env: GATEWAZE_USE_CASE (required), GATEWAZE_API_URL (AI module base URL),
//      SUPABASE_SERVICE_ROLE_KEY (presented as x-gatewaze-internal-key).

import { createInterface } from 'node:readline';

const USE_CASE = process.env.GATEWAZE_USE_CASE;
const API_BASE = (process.env.GATEWAZE_API_URL || process.env.GATEWAZE_INTERNAL_API_URL || '').replace(/\/$/, '');
const INTERNAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!USE_CASE) process.stderr.write('gatewaze-wiki-mcp: GATEWAZE_USE_CASE not set\n');
if (!API_BASE) process.stderr.write('gatewaze-wiki-mcp: GATEWAZE_API_URL not set\n');

async function callInternal(method, path, { query, body } = {}) {
  const url = new URL(`${API_BASE}/api/modules/ai/internal/wiki/${path}`);
  url.searchParams.set('use_case', USE_CASE);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      'x-gatewaze-internal-key': INTERNAL_KEY || '',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify({ ...body, use_case: USE_CASE }) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: { code: 'bad_response', message: text.slice(0, 200) } }; }
  if (!res.ok) {
    const code = json?.error?.code || `http_${res.status}`;
    const msg = json?.error?.message || `request failed (${res.status})`;
    throw new Error(`${code}: ${msg}`);
  }
  return json;
}

// ─── tools ──────────────────────────────────────────────────────
async function wikiSearch(a) {
  return callInternal('GET', 'search', {
    query: { q: a.query, k: a.k, mode: a.mode, scope: a.scope, kinds: Array.isArray(a.kinds) ? a.kinds.join(',') : a.kinds },
  });
}
async function wikiRead(a) { return callInternal('GET', 'read', { query: { slug: a.slug } }); }
async function wikiList(a) {
  return callInternal('GET', 'list', { query: { prefix: a.prefix, category: a.category, where: a.where ? JSON.stringify(a.where) : undefined, limit: a.limit } });
}
async function wikiUpsert(a) {
  return callInternal('POST', 'upsert', { body: { slug: a.slug, title: a.title, body: a.body, summary: a.summary, category: a.category, metadata: a.metadata } });
}
async function wikiReadSource(a) { return callInternal('GET', 'source', { query: { slug: a.slug } }); }
async function wikiListSources(a) { return callInternal('GET', 'sources', { query: { prefix: a.prefix, limit: a.limit } }); }

// ─── MCP JSON-RPC handler ──────────────────────────────────────
const TOOLS = [
  {
    name: 'wiki_search',
    description: 'Search the wiki by keyword + meaning (hybrid). Use BEFORE writing to find prior pages on a topic. scope: self (default), granted, or all (cross-wiki, grant-gated). kinds defaults to ["page"]; add "raw" to also search ingested sources.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, k: { type: 'number' }, mode: { type: 'string', enum: ['hybrid', 'keyword', 'semantic'] }, scope: { type: 'string', enum: ['self', 'granted', 'all'] }, kinds: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'wiki_read',
    description: 'Read one wiki page by its path slug (e.g. "conferences/mumbai/submissions/1208848"), returning body, metadata, and outbound links.',
    inputSchema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
  },
  {
    name: 'wiki_upsert',
    description: 'Create or replace a wiki page. Links live in the body as [[path/slug]] (or [[use_case:slug]] cross-wiki, [[raw:slug]] to a source). Put structured fields in metadata (queryable). slug is a path of url-safe segments.',
    inputSchema: { type: 'object', required: ['slug', 'title', 'body'], properties: { slug: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, summary: { type: 'string' }, category: { type: 'string' }, metadata: { type: 'object' } } },
  },
  {
    name: 'wiki_list',
    description: 'List pages by path prefix and/or metadata filter (where, e.g. {"disposition":"keep"}). Metadata listing only — use wiki_search for content search.',
    inputSchema: { type: 'object', properties: { prefix: { type: 'string' }, category: { type: 'string' }, where: { type: 'object' }, limit: { type: 'number' } } },
  },
  {
    name: 'wiki_read_source',
    description: 'Read an immutable raw source by slug (original input you summarise into a page). Read-only.',
    inputSchema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
  },
  {
    name: 'wiki_list_sources',
    description: 'List immutable raw sources by path prefix.',
    inputSchema: { type: 'object', properties: { prefix: { type: 'string' }, limit: { type: 'number' } } },
  },
];

function sendResponse(id, result, error) {
  const msg = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      sendResponse(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'gatewaze-wiki', version: '1.0.0' } });
      return;
    }
    if (method === 'tools/list') { sendResponse(id, { tools: TOOLS }); return; }
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      let result;
      switch (name) {
        case 'wiki_search': result = await wikiSearch(args); break;
        case 'wiki_read': result = await wikiRead(args); break;
        case 'wiki_upsert': result = await wikiUpsert(args); break;
        case 'wiki_list': result = await wikiList(args); break;
        case 'wiki_read_source': result = await wikiReadSource(args); break;
        case 'wiki_list_sources': result = await wikiListSources(args); break;
        default:
          sendResponse(id, null, { code: -32601, message: `Unknown tool: ${name}` });
          return;
      }
      sendResponse(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
      return;
    }
    if (id != null) sendResponse(id, null, { code: -32601, message: `Unknown method: ${method}` });
  } catch (err) {
    if (id != null) sendResponse(id, null, { code: -32000, message: err instanceof Error ? err.message : String(err) });
    else process.stderr.write(`gatewaze-wiki-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch {
    process.stderr.write(`gatewaze-wiki-mcp: non-JSON line dropped: ${trimmed.slice(0, 200)}\n`);
    return;
  }
  void handleMessage(msg);
});
rl.on('close', () => process.exit(0));
