/**
 * Wiki memory runtime attach. spec-ai-memory-wiki.md §5.1.
 *
 * Produces the Goose CLI flags + env that load the gatewaze-wiki stdio MCP
 * (wiki_search/read/upsert/list + read_source/list_sources) for an agentic
 * run, so the model can read + write its durable wiki memory. Auto-attached
 * for every run whose use case has wiki_enabled (default true) — independent
 * of the recipe's declared extensions + the MCP allowlist, mirroring the
 * web-tools bridge. Shared by the recipe (run-recipe-goose) and chat
 * (resolve-chat-mcp) Goose executors.
 *
 * The MCP calls the AI module's /api/modules/ai/internal/wiki/* routes
 * (service-to-service, internal-key authed), so it needs the internal API
 * base. GATEWAZE_USE_CASE + SUPABASE_SERVICE_ROLE_KEY are inherited from the
 * Goose spawn env (the launcher merges process.env); we inject only
 * GATEWAZE_API_URL via the descriptor. A global WIKI_RUNTIME_DISABLED=1
 * kill-switch and a missing internal-API base both fall through to a no-op
 * (the run continues without wiki tools).
 */

// Minimal structural supabase type — avoids coupling to a specific
// SupabaseClient generic instantiation (the recipe + chat callers differ).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = { from(table: string): any };

export interface WikiAttachResult {
  flags: string[];
  env: Record<string, string>;
  warnings: Array<Record<string, unknown>>;
  loadedNames: string[];
}

const EMPTY: WikiAttachResult = { flags: [], env: {}, warnings: [], loadedNames: [] };

async function resolveScriptPath(envOverride: string, scriptName: string): Promise<string> {
  const fromEnv = process.env[envOverride];
  if (fromEnv) return fromEnv;
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const { existsSync } = await import('node:fs');
  // This file compiles to .../modules/ai/lib/wiki/runtime-attach.js, so the
  // scripts dir is ../../scripts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const here = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath((globalThis as any).import?.meta?.url ?? `file://${process.cwd()}/`));
  const candidates = [
    resolve(here, '..', '..', 'scripts', scriptName),
    resolve(here, '..', '..', '..', 'scripts', scriptName),
    `/usr/local/bin/${scriptName.replace(/\.mjs$/, '')}`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`${scriptName} not found. Tried: ${candidates.join(', ')}. Set ${envOverride} to override.`);
}

export async function resolveWikiAttach(
  supabase: SupabaseLike,
  useCaseId: string,
): Promise<WikiAttachResult> {
  if (process.env.WIKI_RUNTIME_DISABLED === '1') return EMPTY;

  // Per-use-case participation. The wiki MCP (live tools) is attached ONLY
  // for effective mode 'tools'. spec-ai-wiki-runtime-integration.md §4.2:
  //   - wiki_enabled=false  OR  wiki_mode='off'      → 'off'  → no attach
  //   - wiki_mode='context'                          → no attach (memory is
  //     delivered out-of-band via the runner's recall/persist, not MCP tools)
  //   - wiki_mode='tools' (default)                  → attach the MCP
  // Pre-migration (no wiki_mode column) the select on it errors → we fall back
  // to the legacy wiki_enabled boolean (default-on 'tools').
  try {
    const res = await supabase
      .from('ai_use_cases')
      .select('wiki_enabled, wiki_mode')
      .eq('id', useCaseId)
      .maybeSingle();
    const row = (res.data as { wiki_enabled?: boolean; wiki_mode?: string } | null) ?? null;
    const effectiveMode =
      row?.wiki_enabled === false ? 'off' : (row?.wiki_mode ?? 'tools');
    if (effectiveMode !== 'tools') return EMPTY;
  } catch {
    // Pre-migration fallback: honour only the legacy boolean.
    try {
      const res = await supabase
        .from('ai_use_cases')
        .select('wiki_enabled')
        .eq('id', useCaseId)
        .maybeSingle();
      const row = (res.data as { wiki_enabled?: boolean } | null) ?? null;
      if (row && row.wiki_enabled === false) return EMPTY;
    } catch {
      // default-on
    }
  }

  const apiBase = process.env.GATEWAZE_INTERNAL_API_URL || process.env.GATEWAZE_API_URL;
  if (!apiBase) {
    return {
      flags: [],
      env: {},
      warnings: [{ code: 'wiki_no_api_base', server: 'gatewaze-wiki', details: 'Set GATEWAZE_INTERNAL_API_URL so the wiki MCP can reach /api/modules/ai/internal/wiki/*.' }],
      loadedNames: [],
    };
  }

  const launcherPath = await resolveScriptPath('GATEWAZE_GOOSE_LAUNCHER_PATH', 'gatewaze-goose-launcher.mjs');
  const scriptPath = await resolveScriptPath('GATEWAZE_WIKI_MCP_PATH', 'gatewaze-wiki-mcp.mjs');
  const descriptorEnvName = 'GATEWAZE_MCP_LAUNCH_DESCRIPTOR_GATEWAZE_WIKI';
  const env: Record<string, string> = {
    [descriptorEnvName]: JSON.stringify({
      cmd: 'node',
      args: [scriptPath],
      env: { GATEWAZE_API_URL: apiBase },
    }),
  };
  return {
    flags: ['--with-extension', `node ${launcherPath} ${descriptorEnvName}`],
    env,
    warnings: [],
    loadedNames: ['gatewaze-wiki'],
  };
}
