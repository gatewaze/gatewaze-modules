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
      flags.push('--with-streamable-http-extension', server.uri as string);
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
