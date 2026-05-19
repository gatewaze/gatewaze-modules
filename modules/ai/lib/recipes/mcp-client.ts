/**
 * MCP streamable_http client — minimal JSON-RPC 2.0 over HTTP per
 * the MCP spec's `Streamable HTTP` transport.
 *
 * Per spec-ai-workflows-and-skill-interop.md §4.3 + §7.5:
 *   - Connection-level timeout MCP_HTTP_CONNECT_TIMEOUT_MS (10s).
 *   - Per-message timeout MCP_HTTP_MESSAGE_TIMEOUT_MS (30s).
 *   - Total session timeout MCP_HTTP_SESSION_TIMEOUT_MS (5 min).
 *   - Response body cap per message: 256 KiB.
 *   - SSRF blocklist + DNS re-resolution PER HTTP CONNECTION.
 *
 * v1 implements the synchronous request/response subset — enough to
 * support tools/list + tools/call, which is what recipe steps need.
 * The Streamable HTTP transport's full streaming variant (SSE
 * subscriptions for server-pushed messages) is NOT implemented;
 * recipes call tools synchronously through the LLM provider's
 * tool-use loop, so streaming isn't on the critical path.
 *
 * Auth shapes supported (per spec §4.8):
 *   - `auth.none` — no Authorization header.
 *   - `auth.bearer.env_key` — Authorization: Bearer <resolveGatewazeEnvVar(name)>.
 *   - `auth.bearer.use_case_credential: true` — resolves via the
 *     credentials router (caller-supplied closure).
 *
 * `${GATEWAZE_*}` substitution in the URI is handled by the caller
 * (lib/recipes/run-recipe.ts) before passing the URL here.
 */

import { assertHostIpsSafe, checkMcpUrlShape } from './mcp-ssrf.js';

const CONNECT_TIMEOUT_MS = readMs('MCP_HTTP_CONNECT_TIMEOUT_MS', 10_000);
const MESSAGE_TIMEOUT_MS = readMs('MCP_HTTP_MESSAGE_TIMEOUT_MS', 30_000);
const SESSION_TIMEOUT_MS = readMs('MCP_HTTP_SESSION_TIMEOUT_MS', 5 * 60_000);
const RESPONSE_BODY_CAP = 256 * 1024;

export interface McpAuth {
  bearer_token?: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface McpClientHandle {
  /** Server-declared tool list (cached after initialize). */
  tools(): McpToolDef[];
  /** Invoke a tool by name. */
  call(toolName: string, args: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
  /** Tear down the session (best-effort notify, then forget the session id). */
  close(): Promise<void>;
}

export interface CreateMcpClientArgs {
  uri: string;
  auth: McpAuth;
  /** Optional logger; defaults to console. */
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/**
 * Connect to an MCP streamable_http server, run the initialize +
 * tools/list handshake, and return a handle. Throws on SSRF check
 * fail, connect timeout, init failure, etc. — caller is expected to
 * surface these as a step failure.
 */
export async function createMcpClient(args: CreateMcpClientArgs): Promise<McpClientHandle> {
  const shape = checkMcpUrlShape(args.uri);
  if (!shape.ok) {
    throw new Error(`mcp_url_refused: ${shape.reason}`);
  }
  const dns = await assertHostIpsSafe(args.uri);
  if (!dns.ok) {
    throw new Error(`mcp_dns_refused: ${dns.reason}`);
  }

  const sessionStart = Date.now();
  let sessionId: string | null = null;
  let nextRequestId = 1;
  let tools: McpToolDef[] = [];
  let closed = false;
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (args.auth.bearer_token) baseHeaders['Authorization'] = `Bearer ${args.auth.bearer_token}`;

  async function request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (closed) throw new Error('mcp_session_closed');
    if (Date.now() - sessionStart > SESSION_TIMEOUT_MS) {
      throw new Error('mcp_session_timeout');
    }
    const id = nextRequestId++;
    const headers: Record<string, string> = { ...baseHeaders };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('mcp_message_timeout')), MESSAGE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(args.uri, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        `mcp_http_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // Capture session ID off the initialize response — subsequent
    // requests must echo it back.
    if (method === 'initialize') {
      const sid = res.headers.get('Mcp-Session-Id');
      if (sid && sid.length > 0) sessionId = sid;
    }

    if (!res.ok) {
      const body = await readCappedText(res);
      throw new Error(`mcp_http_${res.status}: ${body.slice(0, 500)}`);
    }

    const body = await readCappedText(res);
    // The Streamable HTTP transport allows the response to be either
    // application/json (synchronous single response) or text/event-
    // stream (server-pushed). v1 handles the synchronous path; if we
    // see SSE we extract the first `data:` payload as JSON.
    const contentType = res.headers.get('Content-Type') ?? '';
    const jsonText = contentType.includes('text/event-stream')
      ? extractFirstSseData(body)
      : body;
    if (jsonText == null) {
      throw new Error('mcp_no_json_response');
    }
    let parsed: { id?: number; result?: unknown; error?: { code: number; message: string } };
    try {
      parsed = JSON.parse(jsonText) as typeof parsed;
    } catch (err) {
      throw new Error(`mcp_invalid_json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.error) {
      throw new Error(`mcp_jsonrpc_error_${parsed.error.code}: ${parsed.error.message}`);
    }
    return parsed.result as T;
  }

  // ── Handshake ──────────────────────────────────────────────────
  // initialize → notifications/initialized → tools/list
  // The "client" half of the MCP handshake. Capabilities advertise
  // only the tools surface — we don't support resources / prompts /
  // sampling in v1.
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'gatewaze-ai', version: '1.0.0' },
  });
  // notifications/initialized: a notification (no id, no response)
  // sent over the same channel. We do a fire-and-forget HTTP POST.
  try {
    const headers: Record<string, string> = { ...baseHeaders };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    await fetch(args.uri, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    }).catch(() => undefined);
  } catch {
    // best-effort
  }

  const toolsResult = await request<{ tools?: McpToolDef[] }>('tools/list');
  if (toolsResult && Array.isArray(toolsResult.tools)) {
    tools = toolsResult.tools;
  }

  args.logger?.info('mcp.client.connected', {
    uri: args.uri,
    resolved_ips: dns.resolved_ips,
    tool_count: tools.length,
    session_id: sessionId,
  });

  return {
    tools: () => tools,
    async call(toolName, callArgs) {
      try {
        const result = await request<{ content?: unknown; isError?: boolean }>('tools/call', {
          name: toolName,
          arguments: callArgs,
        });
        if (result?.isError) {
          return { ok: false, error: `tool_error: ${JSON.stringify(result.content).slice(0, 500)}` };
        }
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      // Best-effort session-end notification.
      try {
        const headers: Record<string, string> = { ...baseHeaders };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        await fetch(args.uri, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
        }).catch(() => undefined);
      } catch {
        // best-effort
      }
    },
  };
}

async function readCappedText(res: Response): Promise<string> {
  // Stream the body but stop reading past the cap. Node fetch's Response
  // already exposes a ReadableStream; we read it in chunks.
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > RESPONSE_BODY_CAP) {
      // Drop the rest; we have enough to report the cap breach.
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new Error(`mcp_response_too_large: > ${RESPONSE_BODY_CAP} bytes`);
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function extractFirstSseData(body: string): string | null {
  // Server-Sent Events frames: blocks separated by \n\n. Lines
  // beginning with `data:` carry the payload (concatenated by '\n'
  // if multiple per block). We only take the first complete block.
  const blocks = body.split(/\n\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) return data.join('\n');
  }
  return null;
}

function readMs(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 30 * 60_000) return fallback;
  return n;
}
