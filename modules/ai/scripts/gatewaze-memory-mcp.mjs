#!/usr/bin/env node
/**
 * spec-ai-mcp-extensions.md §Memory backing store §Substitution.
 *
 * Stdio MCP server that advertises the same store_memory /
 * retrieve_memory / list_memory tools as Goose's `memory` builtin,
 * but persists to the Gatewaze-owned ai_memory table rather than
 * Goose's local FS. The wrapper substitutes --with-extension
 * <this-script> for --with-builtin memory whenever an operator has
 * allowlisted 'memory' on a use case.
 *
 * Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0 on
 * stdin/stdout. Methods we implement:
 *   - initialize           handshake, advertise capabilities
 *   - tools/list           return tool surface
 *   - tools/call           dispatch store / retrieve / list
 *
 * Scope is read from the spawn's env (set by the safe-spawn shim):
 *   GATEWAZE_USE_CASE     required — use case id
 *   GATEWAZE_THREAD_ID    set when scope='thread'
 *   GATEWAZE_USER_ID      set when scope='user'
 *   SUPABASE_URL          required
 *   SUPABASE_SERVICE_ROLE_KEY  required
 *
 * Run standalone for debugging:
 *   echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | gatewaze-memory-mcp
 */

import { createInterface } from 'node:readline';
import process from 'node:process';

const USE_CASE = process.env.GATEWAZE_USE_CASE;
const THREAD_ID = process.env.GATEWAZE_THREAD_ID || null;
const USER_ID = process.env.GATEWAZE_USER_ID || null;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!USE_CASE) {
  process.stderr.write('gatewaze-memory-mcp: GATEWAZE_USE_CASE env required\n');
  process.exit(2);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  process.stderr.write('gatewaze-memory-mcp: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env required\n');
  process.exit(2);
}

// ─── PostgREST client (minimal — avoid pulling supabase-js into the
// stdio path so the binary stays slim) ───────────────────────────
async function pgrest(method, table, opts = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(opts.params || {})) {
    url.searchParams.set(k, v);
  }
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': opts.prefer || '',
  };
  const init = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(url.toString(), init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`pgrest ${method} ${table} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─── tool implementations ──────────────────────────────────────
async function storeMemory({ key, value, scope = 'thread', ttl_seconds }) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw new Error('key must be a non-empty string ≤ 200 chars');
  }
  if (!['thread', 'use_case', 'user'].includes(scope)) {
    throw new Error("scope must be 'thread' | 'use_case' | 'user'");
  }
  if (scope === 'thread' && !THREAD_ID) {
    throw new Error('scope=thread requires GATEWAZE_THREAD_ID env');
  }
  if (scope === 'user' && !USER_ID) {
    throw new Error('scope=user requires GATEWAZE_USER_ID env');
  }
  const row = {
    use_case: USE_CASE,
    scope,
    thread_id: scope === 'thread' ? THREAD_ID : null,
    user_id: scope === 'user' ? USER_ID : null,
    key,
    value,
    expires_at: typeof ttl_seconds === 'number' && ttl_seconds > 0
      ? new Date(Date.now() + ttl_seconds * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  };
  // PostgREST upsert: on_conflict matches the per-scope partial unique index.
  const onConflict = scope === 'thread'
    ? 'use_case,thread_id,key'
    : scope === 'use_case'
      ? 'use_case,key'
      : 'use_case,user_id,key';
  await pgrest('POST', 'ai_memory', {
    body: row,
    params: { on_conflict: onConflict },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  return { ok: true, scope, key };
}

async function retrieveMemory({ key, scope }) {
  if (typeof key !== 'string') throw new Error('key required');

  // Build the filter for a specific scope or fall-through search.
  const scopes = scope ? [scope] : ['thread', 'use_case', 'user'];
  for (const s of scopes) {
    if (s === 'thread' && !THREAD_ID) continue;
    if (s === 'user' && !USER_ID) continue;
    const params = {
      use_case: `eq.${USE_CASE}`,
      scope: `eq.${s}`,
      key: `eq.${key}`,
      select: 'value,expires_at',
    };
    if (s === 'thread') params.thread_id = `eq.${THREAD_ID}`;
    if (s === 'user') params.user_id = `eq.${USER_ID}`;
    const rows = await pgrest('GET', 'ai_memory', { params });
    if (Array.isArray(rows) && rows.length > 0) {
      const r = rows[0];
      // Filter out expired (the cron sweeps but this is defensive).
      if (r.expires_at && new Date(r.expires_at) <= new Date()) continue;
      return { found: true, scope: s, key, value: r.value };
    }
  }
  return { found: false, key };
}

async function listMemory({ scope } = {}) {
  const scopes = scope ? [scope] : ['thread', 'use_case', 'user'];
  const out = [];
  for (const s of scopes) {
    if (s === 'thread' && !THREAD_ID) continue;
    if (s === 'user' && !USER_ID) continue;
    const params = {
      use_case: `eq.${USE_CASE}`,
      scope: `eq.${s}`,
      select: 'key,expires_at,updated_at',
      order: 'updated_at.desc',
      limit: '200',
    };
    if (s === 'thread') params.thread_id = `eq.${THREAD_ID}`;
    if (s === 'user') params.user_id = `eq.${USER_ID}`;
    const rows = await pgrest('GET', 'ai_memory', { params });
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (r.expires_at && new Date(r.expires_at) <= new Date()) continue;
        out.push({ scope: s, key: r.key, updated_at: r.updated_at, expires_at: r.expires_at });
      }
    }
  }
  return { entries: out };
}

// ─── MCP JSON-RPC handler ──────────────────────────────────────
const TOOLS = [
  {
    name: 'store_memory',
    description: 'Store a key/value pair for later retrieval. Scope: thread (default — visible only to this conversation), use_case (shared across all threads of this workflow), user (per-user across workflows). Optional ttl_seconds expires the entry automatically.',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: { type: 'string', maxLength: 200 },
        value: {},
        scope: { type: 'string', enum: ['thread', 'use_case', 'user'] },
        ttl_seconds: { type: 'number', minimum: 1 },
      },
    },
  },
  {
    name: 'retrieve_memory',
    description: 'Fetch a stored value by key. Without scope, searches thread → use_case → user and returns the first hit.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
        scope: { type: 'string', enum: ['thread', 'use_case', 'user'] },
      },
    },
  },
  {
    name: 'list_memory',
    description: 'Enumerate stored keys. Optional scope filter.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['thread', 'use_case', 'user'] },
      },
    },
  },
];

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
        serverInfo: { name: 'gatewaze-memory', version: '1.0.0' },
      });
      return;
    }
    if (method === 'tools/list') {
      sendResponse(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      let result;
      switch (name) {
        case 'store_memory':   result = await storeMemory(args); break;
        case 'retrieve_memory': result = await retrieveMemory(args); break;
        case 'list_memory':    result = await listMemory(args); break;
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
    // notifications/initialized + others: no-op
    if (id != null) {
      sendResponse(id, null, { code: -32601, message: `Unknown method: ${method}` });
    }
  } catch (err) {
    if (id != null) {
      sendResponse(id, null, { code: -32000, message: err instanceof Error ? err.message : String(err) });
    } else {
      process.stderr.write(`gatewaze-memory-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
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
    process.stderr.write(`gatewaze-memory-mcp: non-JSON line dropped: ${trimmed.slice(0, 200)}\n`);
    return;
  }
  void handleMessage(msg);
});
rl.on('close', () => process.exit(0));
