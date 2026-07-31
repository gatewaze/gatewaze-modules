// @ts-nocheck
/**
 * §10 — connected tools (MCP) for the agent sessions. SOFT: every failure resolves to `{}` so the
 * pipeline runs unchanged when nothing is configured.
 *
 * Two sources, merged (per-project wins on name collision):
 *   1. A default "gatewaze" MCP server, opt-in via the SE_DEFAULT_MCP_URL env (+ optional
 *      SE_DEFAULT_MCP_TOKEN). Gives every project's agents the platform's own MCP by default.
 *   2. Per-project servers from the sealed `mcp_config_ciphertext` column — SDK-shaped
 *      `{ servers: { name: { type, url, headers, ... } } }`. This is where a project's own Jira /
 *      Slack MCP endpoints (with their bearer tokens) live; the blob is decrypted only here.
 *
 * The returned object is passed verbatim as the SDK `mcpServers` option. We never log its contents
 * (they carry tokens).
 */
import { decryptSecret } from '@gatewaze/shared/modules';

// Only REMOTE transports are ever allowed. A stdio/local server config is `{ command, args, env }`
// which the Agent SDK spawns as a child process — and the runner executes as root, so a sealed
// stdio config would be arbitrary root RCE the next time the project's agent runs. We hard-reject
// any local-exec shape here (and again in the admin validator) — defense in depth.
const ALLOWED_MCP_TYPES = new Set(['http', 'sse']);
const LOCAL_EXEC_KEYS = ['command', 'args', 'env'];
// Server names become object keys — reject prototype-pollution keys before writing them.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate + narrow an MCP servers map to remote (http/sse) entries only. THROWS on anything that
 * could run a local process. Used by the admin write-path (reject bad input at 400) and the
 * read-path resolver (ignore an unsafe stored blob rather than execute it).
 */
export function assertRemoteMcpServers(servers: unknown): Record<string, unknown> {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('mcp servers must be an object');
  const out: Record<string, unknown> = Object.create(null); // no prototype → no pollution sink
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(name) || !/^[a-zA-Z0-9._-]{1,64}$/.test(name)) throw new Error(`mcp server name "${name}" is invalid`);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`mcp server "${name}" must be an object`);
    const c = cfg as Record<string, unknown>;
    if (!ALLOWED_MCP_TYPES.has(c.type as string)) throw new Error(`mcp server "${name}" type must be one of http, sse`);
    for (const k of LOCAL_EXEC_KEYS) if (k in c) throw new Error(`mcp server "${name}" must not set "${k}" (local process execution is not allowed)`);
    if (typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url)) throw new Error(`mcp server "${name}" must have an http(s) url`);
    out[name] = c;
  }
  return out;
}

function defaultServer(): Record<string, unknown> {
  const url = process.env.SE_DEFAULT_MCP_URL;
  if (!url) return {};
  const token = process.env.SE_DEFAULT_MCP_TOKEN;
  return {
    gatewaze: {
      type: 'http',
      url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  };
}

/** The bearer/header secret VALUES embedded in a resolved MCP server map (+ the default token), so
 *  they can be scrubbed from any error surfaced to logs/UI. Never returns the header names. */
export function mcpSecretValues(servers: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  if (process.env.SE_DEFAULT_MCP_TOKEN) out.push(process.env.SE_DEFAULT_MCP_TOKEN);
  for (const cfg of Object.values(servers ?? {})) {
    const headers = (cfg as Record<string, unknown>)?.headers as Record<string, unknown> | undefined;
    for (const v of Object.values(headers ?? {})) {
      if (typeof v !== 'string') continue;
      out.push(v);
      const m = v.match(/^\s*Bearer\s+(.+)$/i); // also scrub the bare token, not just "Bearer <token>"
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}

/** Build the MCP server map for a project's agents. Best-effort — returns {} on any problem. */
export function resolveMcpServers(project: { mcpConfigCiphertext?: string | null } | null): Record<string, unknown> {
  const servers: Record<string, unknown> = { ...defaultServer() };
  try {
    if (project?.mcpConfigCiphertext) {
      const cfg = JSON.parse(decryptSecret(project.mcpConfigCiphertext));
      const perProject = cfg?.servers ?? cfg ?? {};
      // Re-validate at read time: never execute an unsafe stored shape even if it slipped past the
      // write-path (e.g. sealed by an older build). assertRemoteMcpServers throws → we keep default only.
      Object.assign(servers, assertRemoteMcpServers(perProject));
    }
  } catch { /* malformed/undecryptable/unsafe config → fall back to whatever default resolved */ }
  return servers;
}
