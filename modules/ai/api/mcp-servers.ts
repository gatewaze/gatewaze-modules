// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * spec-ai-mcp-extensions.md §API Design — operator-managed MCP server
 * registry CRUD + Test probe. Mounted under /api/modules/ai/admin/.
 *
 * Secrets (env values, bearer tokens) accepted as plaintext on the wire
 * (HTTPS-only — API behind Traefik with HSTS), encrypted with the
 * shared GATEWAZE_SECRETS_KEY envelope before INSERT. Reads NEVER
 * return ciphertext or plaintext — only env_keys (names) and a
 * bearer_token_set boolean.
 */

import type { Router, Request, Response } from 'express';
import { encryptSecret } from '../lib/skills/secret-shim.js';
import { checkSsrfSafe } from '../lib/secrets/ssrf-guard.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

interface MountDeps {
  supabase: SupabaseLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enqueueJob?: (q: string, j: string, d: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const STDIO_ALLOWED_CMDS_DEFAULT = ['uvx', 'npx'];

function getAllowedCmds(): Set<string> {
  const raw = process.env.AI_MCP_STDIO_ALLOWED_CMDS;
  if (!raw) return new Set(STDIO_ALLOWED_CMDS_DEFAULT);
  return new Set(
    raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
  );
}

function isShellMeta(arg: string): boolean {
  return /[;&|`$()<>]/.test(arg);
}

function sendError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } });
}

interface McpServerRow {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  type: 'stdio' | 'streamable_http' | 'builtin';
  enabled: boolean;
  cmd: string | null;
  args: string[] | null;
  env_keys: string[];
  envs_ciphertext: string | null;
  uri: string | null;
  bearer_token_ciphertext: string | null;
  headers: Record<string, string>;
  builtin_name: string | null;
  timeout_seconds: number;
  last_tested_at: string | null;
  last_tested_status: 'ok' | 'error' | null;
  last_tested_error: string | null;
  last_tested_tools: unknown;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

function toResponse(row: McpServerRow): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    description: row.description,
    type: row.type,
    enabled: row.enabled,
    timeout_seconds: row.timeout_seconds,
    last_tested_at: row.last_tested_at,
    last_tested_status: row.last_tested_status,
    last_tested_error: row.last_tested_error,
    last_tested_tools: row.last_tested_tools,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    // Per-type-discriminated blocks. Non-matching are null for stable shape.
    stdio: row.type === 'stdio' ? {
      cmd: row.cmd,
      args: row.args ?? [],
      env_keys: row.env_keys,
      envs_set: row.envs_ciphertext != null,
    } : null,
    streamable_http: row.type === 'streamable_http' ? {
      uri: row.uri,
      headers: row.headers,
      bearer_token_set: row.bearer_token_ciphertext != null,
    } : null,
    builtin: row.type === 'builtin' ? {
      builtin_name: row.builtin_name,
    } : null,
    // capabilities is system-inferred — read-only per spec.
    capabilities: {
      supports_bearer_token_injection: row.type === 'streamable_http',
      tool_call_capture: 'best_effort' as const,
    },
  };
  return base;
}

function validateStdioCmd(cmd: unknown, args: unknown, envs: unknown, env_keys: unknown): string | null {
  if (typeof cmd !== 'string' || cmd.length === 0) return 'stdio.cmd required';
  if (!getAllowedCmds().has(cmd)) {
    return `stdio.cmd '${cmd}' not in allowlist (AI_MCP_STDIO_ALLOWED_CMDS)`;
  }
  if (!Array.isArray(args)) return 'stdio.args must be a string array';
  for (const a of args) {
    if (typeof a !== 'string' || a.length === 0) return 'stdio.args elements must be non-empty strings';
    if (isShellMeta(a)) return `stdio.args element contains shell metacharacters: ${a}`;
  }
  if (env_keys !== undefined && env_keys !== null) {
    if (!Array.isArray(env_keys)) return 'stdio.env_keys must be a string array';
    for (const k of env_keys) {
      if (typeof k !== 'string' || !ENV_KEY_RE.test(k)) return `stdio.env_keys element invalid: ${k}`;
    }
  }
  if (envs !== undefined && envs !== null) {
    if (typeof envs !== 'object' || Array.isArray(envs)) return 'stdio.envs must be an object';
    for (const [k, v] of Object.entries(envs as Record<string, unknown>)) {
      if (!ENV_KEY_RE.test(k)) return `stdio.envs key invalid: ${k}`;
      if (typeof v !== 'string') return `stdio.envs value for ${k} must be a string`;
    }
  }
  return null;
}

function validateHttpUri(uri: unknown): string | null {
  if (typeof uri !== 'string') return 'streamable_http.uri required';
  if (!/^https:\/\//.test(uri)) return 'streamable_http.uri must start with https://';
  try {
    new URL(uri);
  } catch {
    return 'streamable_http.uri is not a parseable URL';
  }
  return null;
}

const FORBIDDEN_HTTP_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);
function validateHttpHeaders(headers: unknown): string | null {
  if (headers === undefined || headers === null) return null;
  if (typeof headers !== 'object' || Array.isArray(headers)) return 'streamable_http.headers must be an object';
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (FORBIDDEN_HTTP_HEADERS.has(k.toLowerCase())) {
      return `streamable_http.headers must not contain ${k} (use bearer_token instead)`;
    }
    if (typeof v !== 'string') return `streamable_http.headers[${k}] must be a string`;
  }
  return null;
}

function validateBuiltin(builtin_name: unknown): string | null {
  if (typeof builtin_name !== 'string' || builtin_name.length === 0) {
    return 'builtin.builtin_name required';
  }
  return null;
}

export function mountMcpServerRoutes(router: Router, deps: MountDeps): void {
  // ─── LIST ──────────────────────────────────────────────────────
  router.get('/admin/mcp-servers', async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await deps.supabase
        .from('ai_mcp_servers')
        .select('*')
        .order('name', { ascending: true });
      if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
      const rows = (result.data ?? []) as McpServerRow[];
      res.status(200).json({ servers: rows.map(toResponse), total: rows.length });
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ─── GET ───────────────────────────────────────────────────────
  router.get('/admin/mcp-servers/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'bad_request', 'id required');
    const result = await deps.supabase
      .from('ai_mcp_servers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
    if (!result.data) return sendError(res, 404, 'not_found', 'MCP server not found');
    res.status(200).json(toResponse(result.data as McpServerRow));
  });

  // ─── CREATE ────────────────────────────────────────────────────
  router.post('/admin/mcp-servers', async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = body.name;
    const display_name = body.display_name;
    const description = body.description ?? null;
    const type = body.type;
    const enabled = body.enabled ?? true;
    const timeout_seconds = body.timeout_seconds ?? 300;

    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      return sendError(res, 400, 'validation_error', 'name must match ^[a-z][a-z0-9]*(-[a-z0-9]+)*$');
    }
    if (typeof display_name !== 'string' || display_name.length === 0) {
      return sendError(res, 400, 'validation_error', 'display_name required');
    }
    if (type !== 'stdio' && type !== 'streamable_http' && type !== 'builtin') {
      return sendError(res, 400, 'validation_error', "type must be 'stdio' | 'streamable_http' | 'builtin'");
    }
    if (typeof timeout_seconds !== 'number' || timeout_seconds <= 0 || timeout_seconds > 3600) {
      return sendError(res, 400, 'validation_error', 'timeout_seconds must be 1..3600');
    }

    const row: Record<string, unknown> = {
      name, display_name, description, type, enabled, timeout_seconds,
      env_keys: [], headers: {},
    };

    if (type === 'stdio') {
      const stdio = (body.stdio ?? body) as Record<string, unknown>;
      const cmd = stdio.cmd;
      const args = stdio.args;
      const env_keys = stdio.env_keys ?? [];
      const envs = stdio.envs ?? {};
      const validationError = validateStdioCmd(cmd, args, envs, env_keys);
      if (validationError) return sendError(res, 400, 'validation_error', validationError);
      row.cmd = cmd;
      row.args = args;
      row.env_keys = env_keys;
      if (envs && Object.keys(envs as Record<string, unknown>).length > 0) {
        row.envs_ciphertext = encryptSecret(JSON.stringify(envs));
      }
    } else if (type === 'streamable_http') {
      const http = (body.streamable_http ?? body) as Record<string, unknown>;
      const uri = http.uri;
      const headers = http.headers ?? {};
      const bearer_token = http.bearer_token;
      const e1 = validateHttpUri(uri);
      if (e1) return sendError(res, 400, 'validation_error', e1);
      const e2 = validateHttpHeaders(headers);
      if (e2) return sendError(res, 400, 'validation_error', e2);
      // SSRF defense: resolve hostname + reject any non-public address.
      // Defence-in-depth — the connect-time check happens too.
      const ssrf = await checkSsrfSafe(uri as string);
      if (!ssrf.ok) {
        return sendError(res, 400, 'ssrf_blocked', `URI rejected by SSRF guard: ${ssrf.reason}`, ssrf.details);
      }
      if (bearer_token !== undefined && bearer_token !== null && typeof bearer_token !== 'string') {
        return sendError(res, 400, 'validation_error', 'bearer_token must be a string');
      }
      row.uri = uri;
      row.headers = headers;
      if (typeof bearer_token === 'string' && bearer_token.length > 0) {
        row.bearer_token_ciphertext = encryptSecret(JSON.stringify(bearer_token));
      }
    } else { // builtin
      const builtin = (body.builtin ?? body) as Record<string, unknown>;
      const builtin_name = builtin.builtin_name;
      const e = validateBuiltin(builtin_name);
      if (e) return sendError(res, 400, 'validation_error', e);
      row.builtin_name = builtin_name;
    }

    const result = await deps.supabase
      .from('ai_mcp_servers')
      .insert(row)
      .select('*')
      .maybeSingle();
    if (result.error) {
      const msg = String(result.error.message ?? '');
      if (msg.includes('ai_mcp_servers_name_key') || msg.includes('duplicate key')) {
        return sendError(res, 409, 'name_conflict', `name '${name}' already exists`);
      }
      return sendError(res, 500, 'internal_error', msg);
    }
    res.status(201).json(toResponse(result.data as McpServerRow));
  });

  // ─── UPDATE (PATCH) ────────────────────────────────────────────
  router.patch('/admin/mcp-servers/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'bad_request', 'id required');
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Load existing to learn its type — we can't switch type via PATCH
    // (type is immutable; that would shed required columns).
    const existing = await deps.supabase
      .from('ai_mcp_servers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (existing.error) return sendError(res, 500, 'internal_error', existing.error.message);
    if (!existing.data) return sendError(res, 404, 'not_found', 'MCP server not found');
    const row = existing.data as McpServerRow;

    if (body.type !== undefined && body.type !== row.type) {
      return sendError(res, 409, 'immutable_field', 'type is immutable; delete + recreate to switch');
    }
    if (body.name !== undefined && body.name !== row.name) {
      return sendError(res, 409, 'immutable_field', 'name is immutable; delete + recreate to rename');
    }

    const update: Record<string, unknown> = {};
    if (typeof body.display_name === 'string') update.display_name = body.display_name;
    if (body.description !== undefined) update.description = body.description ?? null;
    if (typeof body.enabled === 'boolean') update.enabled = body.enabled;
    if (typeof body.timeout_seconds === 'number') {
      if (body.timeout_seconds <= 0 || body.timeout_seconds > 3600) {
        return sendError(res, 400, 'validation_error', 'timeout_seconds must be 1..3600');
      }
      update.timeout_seconds = body.timeout_seconds;
    }

    if (row.type === 'stdio') {
      const stdio = (body.stdio ?? {}) as Record<string, unknown>;
      if (stdio.args !== undefined) {
        const validationError = validateStdioCmd(row.cmd, stdio.args, stdio.envs, stdio.env_keys);
        if (validationError) return sendError(res, 400, 'validation_error', validationError);
        update.args = stdio.args;
      }
      if (Array.isArray(stdio.env_keys)) update.env_keys = stdio.env_keys;
      if (stdio.envs !== undefined) {
        if (stdio.envs === null || (typeof stdio.envs === 'object' && Object.keys(stdio.envs).length === 0)) {
          update.envs_ciphertext = null;
        } else {
          update.envs_ciphertext = encryptSecret(JSON.stringify(stdio.envs));
        }
      }
    } else if (row.type === 'streamable_http') {
      const http = (body.streamable_http ?? {}) as Record<string, unknown>;
      if (http.uri !== undefined) {
        const e = validateHttpUri(http.uri);
        if (e) return sendError(res, 400, 'validation_error', e);
        update.uri = http.uri;
      }
      if (http.headers !== undefined) {
        const e = validateHttpHeaders(http.headers);
        if (e) return sendError(res, 400, 'validation_error', e);
        update.headers = http.headers;
      }
      if (http.bearer_token !== undefined) {
        if (http.bearer_token === null || http.bearer_token === '') {
          update.bearer_token_ciphertext = null;
        } else if (typeof http.bearer_token === 'string') {
          update.bearer_token_ciphertext = encryptSecret(JSON.stringify(http.bearer_token));
        }
      }
    }

    if (Object.keys(update).length === 0) {
      return sendError(res, 400, 'bad_request', 'no updatable fields supplied');
    }

    const result = await deps.supabase
      .from('ai_mcp_servers')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
    res.status(200).json(toResponse(result.data as McpServerRow));
  });

  // ─── DELETE ────────────────────────────────────────────────────
  router.delete('/admin/mcp-servers/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'bad_request', 'id required');
    // Reject if any use case still references this server.
    const refs = await deps.supabase
      .from('ai_use_case_mcp_allowlist')
      .select('use_case_id', { count: 'exact', head: true })
      .eq('mcp_server_id', id);
    if (refs.error) return sendError(res, 500, 'internal_error', refs.error.message);
    if ((refs.count ?? 0) > 0) {
      return sendError(res, 409, 'referenced_by_use_case', `${refs.count} use case(s) still reference this server — remove the allowlist entries first`);
    }
    const result = await deps.supabase
      .from('ai_mcp_servers')
      .delete()
      .eq('id', id);
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
    res.status(204).send();
  });

  // ─── TEST (synchronous probe, time-bounded) ─────────────────────
  // v1 enqueues a probe job; v0 placeholder returns 501 until the
  // ai:test-mcp-server worker handler lands.
  router.post('/admin/mcp-servers/:id/test', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'bad_request', 'id required');
    if (!deps.enqueueJob) {
      return sendError(res, 503, 'enqueue_unavailable', 'enqueueJob bridge not wired by host');
    }
    const enq = await deps.enqueueJob('jobs', 'ai:test-mcp-server', { server_id: id });
    res.status(202).json({ status: 'queued', job_id: enq.id, server_id: id });
  });
}
