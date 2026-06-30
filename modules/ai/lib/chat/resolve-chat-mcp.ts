/**
 * spec-ai-mcp-extensions.md §3.5 §High-level flow (chat turn).
 *
 * For chat (no recipe to intersect against), the load set is just
 * (use_case.allowed_mcp_servers ∩ enabled). Mirrors the recipe-side
 * resolver in shape so the chat handler can drop in unchanged.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = { from(table: string): any };

export interface ChatMcpResolveResult {
  flags: string[];
  env: Record<string, string>;
  loadedNames: string[];
  warnings: Array<Record<string, unknown>>;
}

export async function resolveChatMcpExtensions(
  supabase: SupabaseLike,
  useCaseId: string,
): Promise<ChatMcpResolveResult> {
  const flags: string[] = [];
  const env: Record<string, string> = {};
  const loadedNames: string[] = [];
  const warnings: Array<Record<string, unknown>> = [];

  // Web-tools bridge: same machinery as run-recipe-goose so the UI's
  // "Allowed web tools" checkboxes apply identically across chat +
  // recipe executors. Lives at the top so an empty MCP allowlist
  // still gets the web-tools surface.
  {
    const webBridge = await resolveWebToolsForChat(supabase, useCaseId);
    flags.push(...webBridge.flags);
    Object.assign(env, webBridge.env);
    loadedNames.push(...webBridge.loadedNames);
    warnings.push(...webBridge.warnings);
  }

  // Wiki memory bridge: attach the gatewaze-wiki MCP so chat use cases get the
  // same durable, searchable cross-turn memory as recipe runs (wiki_search/
  // read/upsert/list). Same auto-attach machinery as run-recipe-goose.
  // spec-ai-memory-wiki.md §5.1.
  {
    const { resolveWikiAttach } = await import('../wiki/runtime-attach.js');
    const wikiBridge = await resolveWikiAttach(supabase as never, useCaseId);
    flags.push(...wikiBridge.flags);
    Object.assign(env, wikiBridge.env);
    loadedNames.push(...wikiBridge.loadedNames);
    warnings.push(...wikiBridge.warnings);
  }

  // Load the full allowlist + joined server config in one query.
  const res = await supabase
    .from('ai_use_case_mcp_allowlist')
    .select('mcp_server_id, ai_mcp_servers(name, type, enabled, cmd, args, envs_ciphertext, uri, bearer_token_ciphertext, headers, builtin_name)')
    .eq('use_case_id', useCaseId);
  if (res.error) throw new Error(`chat_mcp_allowlist_load_failed: ${res.error.message}`);
  const rows = (res.data ?? []) as Array<{ ai_mcp_servers: Record<string, unknown> }>;

  for (const row of rows) {
    const server = row.ai_mcp_servers;
    if (!server) continue;
    const name = server.name as string;
    if (server.enabled === false) {
      warnings.push({ code: 'mcp_disabled', server: name });
      continue;
    }
    // Per-(use_case, mcp_server) hourly rate limit. Same machinery as
    // the recipe resolver. Rate-limited servers are excluded from
    // this turn with a structured warning; chat continues.
    {
      const { checkMcpRateLimit } = await import('../mcp/rate-limit.js');
      const decision = await checkMcpRateLimit(supabase, useCaseId, name);
      if (!decision.allowed) {
        warnings.push({
          code: 'mcp_rate_limited',
          server: name,
          details: `Trailing hour count ${decision.count} >= cap ${decision.cap}.`,
        });
        continue;
      }
    }
    const type = server.type as string;
    if (type === 'stdio') {
      // Reuse the same descriptor-via-env shim pattern as recipe runs.
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const { existsSync } = await import('node:fs');
      const envPath = process.env.GATEWAZE_GOOSE_LAUNCHER_PATH;
      let launcherPath = envPath;
      if (!launcherPath) {
        const here = dirname(fileURLToPath(import.meta.url));
        const candidates = [
          resolve(here, '..', '..', 'scripts', 'gatewaze-goose-launcher.mjs'),
          resolve(here, '..', '..', '..', 'scripts', 'gatewaze-goose-launcher.mjs'),
          '/usr/local/bin/gatewaze-goose-launcher',
        ];
        launcherPath = candidates.find((c) => existsSync(c));
        if (!launcherPath) throw new Error('gatewaze-goose-launcher not found');
      }
      const cmd = server.cmd as string;
      const argList = (server.args as string[] | null) ?? [];
      const perServerEnv: Record<string, string> = {};
      if (typeof server.envs_ciphertext === 'string' && server.envs_ciphertext.length > 0) {
        const { decryptSecret } = await import('../skills/secret-shim.js');
        const plaintext = decryptSecret(server.envs_ciphertext);
        if (plaintext) {
          try {
            const map = JSON.parse(plaintext) as Record<string, string>;
            for (const [k, v] of Object.entries(map)) {
              if (typeof v === 'string') perServerEnv[k] = v;
            }
          } catch { warnings.push({ code: 'mcp_envs_decrypt_parse_failed', server: name }); }
        } else {
          warnings.push({ code: 'mcp_envs_decrypt_failed', server: name });
        }
      }
      const descriptorEnvName = `GATEWAZE_MCP_LAUNCH_DESCRIPTOR_${name.toUpperCase().replace(/-/g, '_')}`;
      env[descriptorEnvName] = JSON.stringify({ cmd, args: argList, env: perServerEnv });
      flags.push('--with-extension', `node ${launcherPath} ${descriptorEnvName}`);
    } else if (type === 'streamable_http') {
      // Connect-time SSRF re-check. DNS could rebind between the
      // POST /admin/mcp-servers validation and now.
      const uri = server.uri as string;
      const { checkSsrfSafe } = await import('../secrets/ssrf-guard.js');
      const ssrf = await checkSsrfSafe(uri);
      if (!ssrf.ok) {
        warnings.push({ code: 'mcp_ssrf_blocked', server: name, details: `URI ${uri} blocked at connect-time: ${ssrf.reason}` });
        continue;
      }
      flags.push('--with-streamable-http-extension', uri);
      if (typeof server.bearer_token_ciphertext === 'string' && server.bearer_token_ciphertext.length > 0) {
        const { decryptSecret } = await import('../skills/secret-shim.js');
        const plaintext = decryptSecret(server.bearer_token_ciphertext);
        if (plaintext) {
          try {
            const token = JSON.parse(plaintext) as string;
            env[`GOOSE_HTTP_EXTENSION_${name.toUpperCase().replace(/-/g, '_')}_TOKEN`] = token;
          } catch { warnings.push({ code: 'mcp_bearer_decrypt_parse_failed', server: name }); }
        }
      }
    } else if (type === 'builtin') {
      const builtinName = (server.builtin_name as string) ?? name;
      if (builtinName === 'memory') {
        // Substitute Gatewaze's memory MCP — same pattern as recipe wrapper.
        const { fileURLToPath } = await import('node:url');
        const { dirname, resolve } = await import('node:path');
        const { existsSync } = await import('node:fs');
        let scriptPath = process.env.GATEWAZE_MEMORY_MCP_PATH;
        if (!scriptPath) {
          const here = dirname(fileURLToPath(import.meta.url));
          const candidates = [
            resolve(here, '..', '..', 'scripts', 'gatewaze-memory-mcp.mjs'),
            resolve(here, '..', '..', '..', 'scripts', 'gatewaze-memory-mcp.mjs'),
            '/usr/local/bin/gatewaze-memory-mcp',
          ];
          scriptPath = candidates.find((c) => existsSync(c));
          if (!scriptPath) throw new Error('gatewaze-memory-mcp not found');
        }
        flags.push('--with-extension', `node ${scriptPath}`);
      } else {
        flags.push('--with-builtin', builtinName);
      }
    }
    loadedNames.push(name);
  }
  return { flags, env, loadedNames, warnings };
}

/**
 * Bridge ai_use_cases.allowed_web_tools into the Goose chat spawn by
 * attaching gatewaze-web-tools-mcp for the subset of tools the
 * Gatewaze MCP owns. Currently that's just `gatewaze_search` —
 * web_search and fetch_url come from the model or Goose's builtins.
 *
 * Mirrors resolveWebToolsExtension in lib/recipes/run-recipe-goose.ts.
 */
const MCP_OWNED_TOOLS = new Set(['gatewaze_search']);

async function resolveWebToolsForChat(
  supabase: SupabaseLike,
  useCaseId: string,
): Promise<ChatMcpResolveResult> {
  let allowed: string[] = [];
  try {
    const res = await supabase
      .from('ai_use_cases')
      .select('allowed_web_tools')
      .eq('id', useCaseId)
      .maybeSingle();
    const row = (res.data as { allowed_web_tools?: string[] } | null) ?? null;
    allowed = Array.isArray(row?.allowed_web_tools) ? row!.allowed_web_tools.filter((t) => typeof t === 'string') : [];
  } catch {
    return { flags: [], env: {}, loadedNames: [], warnings: [] };
  }
  const mcpTools = allowed.filter((t) => MCP_OWNED_TOOLS.has(t));
  if (mcpTools.length === 0) {
    return { flags: [], env: {}, loadedNames: [], warnings: [] };
  }

  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const { existsSync } = await import('node:fs');

  // Locate the launcher shim + the web-tools MCP script.
  let launcherPath = process.env.GATEWAZE_GOOSE_LAUNCHER_PATH;
  if (!launcherPath) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '..', '..', 'scripts', 'gatewaze-goose-launcher.mjs'),
      resolve(here, '..', '..', '..', 'scripts', 'gatewaze-goose-launcher.mjs'),
      '/usr/local/bin/gatewaze-goose-launcher',
    ];
    launcherPath = candidates.find((c) => existsSync(c));
    if (!launcherPath) throw new Error('gatewaze-goose-launcher not found');
  }
  let scriptPath = process.env.GATEWAZE_WEB_TOOLS_MCP_PATH;
  if (!scriptPath) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '..', '..', 'scripts', 'gatewaze-web-tools-mcp.mjs'),
      resolve(here, '..', '..', '..', 'scripts', 'gatewaze-web-tools-mcp.mjs'),
      '/usr/local/bin/gatewaze-web-tools-mcp',
    ];
    scriptPath = candidates.find((c) => existsSync(c));
    if (!scriptPath) throw new Error('gatewaze-web-tools-mcp not found');
  }

  const descriptorEnvName = 'GATEWAZE_MCP_LAUNCH_DESCRIPTOR_GATEWAZE_WEB_TOOLS';
  const perServerEnv: Record<string, string> = {
    GATEWAZE_ALLOWED_WEB_TOOLS: mcpTools.join(','),
  };
  for (const k of [
    'SCRAPLING_FETCHER_URL',
    'SCRAPLING_INTERNAL_TOKEN',
    'SERPER_API_KEY',
    'GATEWAZE_SEARCH_BACKEND',
    'GATEWAZE_FETCH_BASE_URL',
    'GATEWAZE_FETCH_API_KEY',
  ]) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length > 0) perServerEnv[k] = v;
  }
  return {
    flags: ['--with-extension', `node ${launcherPath} ${descriptorEnvName}`],
    env: {
      [descriptorEnvName]: JSON.stringify({
        cmd: 'node',
        args: [scriptPath],
        env: perServerEnv,
      }),
    },
    loadedNames: ['gatewaze-web-tools'],
    warnings: [],
  };
}
