/**
 * Worker handler — probes a registered MCP server by spawning a
 * one-shot `goose session` with ONLY that server enabled, asking the
 * model to list its tools, then captures the resulting tool inventory
 * back onto ai_mcp_servers.last_tested_*.
 *
 * spec-ai-mcp-extensions.md §5.3 Test Probe.
 *
 * Bounded 30s wall-clock. SIGKILL after a 5s grace period if the
 * spawned Goose process doesn't exit.
 */

import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '../lib/skills/secret-shim.js';
import { checkSsrfSafe } from '../lib/secrets/ssrf-guard.js';

const GOOSE_BIN = process.env.GOOSE_BIN ?? '/usr/local/bin/goose';
const TEST_TIMEOUT_MS = 30_000;
const GRACE_KILL_MS = 5_000;

interface JobInput {
  data: { server_id?: string };
  id?: string | number;
}

interface RuntimeContext {
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

interface McpServerRow {
  id: string;
  name: string;
  type: 'stdio' | 'streamable_http' | 'builtin';
  cmd: string | null;
  args: string[] | null;
  envs_ciphertext: string | null;
  uri: string | null;
  bearer_token_ciphertext: string | null;
  builtin_name: string | null;
  timeout_seconds: number;
}

export default async function testMcpServerHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  const log = ctx?.logger ?? {
    info: (msg: string, fields?: Record<string, unknown>) => console.log(`[ai.test-mcp-server] ${msg}`, fields ?? ''),
    warn: (msg: string, fields?: Record<string, unknown>) => console.warn(`[ai.test-mcp-server] ${msg}`, fields ?? ''),
  };

  const serverId = job.data?.server_id;
  if (typeof serverId !== 'string' || serverId.length === 0) {
    return { skipped: true, reason: 'missing_server_id' };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Load the server row.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowRes = await (supabase as any)
    .from('ai_mcp_servers')
    .select('id, name, type, cmd, args, envs_ciphertext, uri, bearer_token_ciphertext, builtin_name, timeout_seconds')
    .eq('id', serverId)
    .maybeSingle();
  if (rowRes.error || !rowRes.data) {
    return { ok: false, reason: 'server_not_found' };
  }
  const server = rowRes.data as McpServerRow;

  const result = await probeServer(server, log);

  // Persist outcome.
  try {
    await (supabase as ReturnType<typeof createClient>)
      .from('ai_mcp_servers')
      .update({
        last_tested_at: new Date().toISOString(),
        last_tested_status: result.ok ? 'ok' : 'error',
        last_tested_error: result.ok ? null : result.error,
        last_tested_tools: result.ok ? result.tools : null,
      })
      .eq('id', serverId);
  } catch (err) {
    log.warn('persist_failed', { error: err instanceof Error ? err.message : String(err), server_id: serverId });
  }

  log.info('test_complete', { server_id: serverId, ok: result.ok, tool_count: result.ok ? result.tools.length : 0 });
  return result;
}

type ProbeResult = { ok: true; tools: string[] } | { ok: false; error: string };

async function probeServer(server: McpServerRow, log: NonNullable<RuntimeContext['logger']>): Promise<ProbeResult> {
  // streamable_http — probe IN-PROCESS with the MCP client (proper
  // Authorization: Bearer), not a Goose subprocess. Goose 1.34 removed
  // `session --no-tty`, and its --with-streamable-http-extension flag carries
  // no auth, so a Goose-based probe both fails to spawn AND can't authenticate.
  // The in-process client tests the exact path the recipe runner uses (connect
  // + initialize + tools/list with the bearer), so a green Test means a recipe
  // run will authenticate too.
  if (server.type === 'streamable_http') {
    if (!server.uri) return { ok: false, error: 'streamable_http.uri missing on row' };
    const ssrf = await checkSsrfSafe(server.uri);
    if (!ssrf.ok) return { ok: false, error: `ssrf_blocked: ${ssrf.reason}` };
    let bearer: string | undefined;
    if (server.bearer_token_ciphertext) {
      const plaintext = decryptSecret(server.bearer_token_ciphertext);
      if (plaintext == null) return { ok: false, error: 'bearer_decrypt_failed' };
      try {
        const t = JSON.parse(plaintext) as unknown;
        if (typeof t === 'string' && t.length > 0) bearer = t;
      } catch {
        return { ok: false, error: 'bearer_decrypt_parse_failed' };
      }
    }
    try {
      const { createMcpClient } = await import('../lib/recipes/mcp-client.js');
      const client = await createMcpClient({ uri: server.uri, auth: { ...(bearer && { bearer_token: bearer }) } });
      try {
        const tools = client.tools().map((t) => t.name).filter((n): n is string => typeof n === 'string');
        log.info('probe_streamable_http_ok', { server: server.name, tool_count: tools.length });
        return { ok: true, tools };
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (err) {
      return { ok: false, error: `mcp_connect_failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // stdio / builtin — probe via a one-shot `goose run`.
  const extensionFlags: string[] = [];
  const extraEnv: Record<string, string> = {};

  if (server.type === 'stdio') {
    if (!server.cmd) return { ok: false, error: 'stdio.cmd missing on row' };
    const cmdStr = [server.cmd, ...((server.args ?? []) as string[])].join(' ');
    extensionFlags.push('--with-extension', cmdStr);
    if (server.envs_ciphertext) {
      const plaintext = decryptSecret(server.envs_ciphertext);
      if (plaintext) {
        try {
          const map = JSON.parse(plaintext) as Record<string, string>;
          for (const [k, v] of Object.entries(map)) if (typeof v === 'string') extraEnv[k] = v;
        } catch {
          return { ok: false, error: 'envs_decrypt_parse_failed' };
        }
      }
    }
  } else if (server.type === 'builtin') {
    if (!server.builtin_name) return { ok: false, error: 'builtin.builtin_name missing on row' };
    extensionFlags.push('--with-builtin', server.builtin_name);
  }

  // Goose 1.34 split chat into `goose session` (interactive, needs a TTY) and
  // `goose run` (one-shot). The old `session --no-tty` invocation now errors
  // with "unexpected argument '--no-tty'", so use one-shot `goose run` (mirrors
  // the chat executor).
  const args = [
    'run',
    '--quiet',
    '--no-session',
    '--output-format', 'stream-json',
    '--text', 'List your available tools as a JSON array of objects with name+description.',
    '--max-turns', '3',
    ...extensionFlags,
  ];

  return new Promise<ProbeResult>((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let resolved = false;
    const child = spawn(GOOSE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    const killTimer = setTimeout(() => {
      if (!child.killed) child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, GRACE_KILL_MS);
    }, TEST_TIMEOUT_MS);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdoutBuf += chunk; });
    child.stderr.on('data', (chunk: string) => { stderrBuf += chunk; });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      resolve({ ok: false, error: `spawn_failed: ${err.message}` });
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      // Parse what Goose advertised. Look for ANY `tools_available`
      // event OR fall back to scanning toolRequest names in stdout.
      const tools = extractToolNames(stdoutBuf);
      if (code === 0 || tools.length > 0) {
        resolve({ ok: true, tools });
      } else {
        const stderr = stderrBuf.slice(-1000) || `exit ${code}`;
        resolve({ ok: false, error: stderr });
      }
    });
    log.info('spawn_started', { args: args.slice(0, 4) });
  });
}

function extractToolNames(stdout: string): string[] {
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>;
      // Goose v1.34 emits a `tools_available` event listing every
      // advertised tool. Some recipe handlers also surface them in
      // the system prompt; capture both shapes.
      if (ev.type === 'tools_available' && Array.isArray((ev as { tools?: unknown }).tools)) {
        for (const t of (ev as { tools: Array<{ name?: string }> }).tools) {
          if (typeof t?.name === 'string') seen.add(t.name);
        }
        continue;
      }
      // Fall-through: any toolRequest inside a Message exposes the
      // tool name in `value.name`.
      if (ev.type === 'message') {
        const msg = (ev.message ?? ev) as { content?: unknown[] };
        if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (!item || typeof item !== 'object') continue;
            const it = item as { type?: string; toolCall?: { value?: { name?: string } } };
            if (it.type === 'toolRequest' && typeof it.toolCall?.value?.name === 'string') {
              seen.add(it.toolCall.value.name);
            }
          }
        }
      }
    } catch {
      // Non-JSON line; skip.
    }
  }
  return Array.from(seen);
}
