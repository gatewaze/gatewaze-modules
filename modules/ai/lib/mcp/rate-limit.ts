/**
 * spec-ai-mcp-extensions.md open question #4 — per-MCP rate limiting.
 *
 * Counts `ai_usage_events` rows tagged `kind='mcp_tool'` for the
 * (use_case, mcp_server) pair within a sliding hour window. If the
 * count exceeds the configured cap, the server is EXCLUDED from the
 * next spawn's load set with a structured warning — the run still
 * proceeds, just without that server's tools.
 *
 * Cap source (highest priority first):
 *   1. ai_use_cases.goose_runtime_overrides.MCP_MAX_TOOL_CALLS_PER_HOUR_<NAME>
 *      (per-server override — future, not in v1 allowlist).
 *   2. ai_use_cases.goose_runtime_overrides.MCP_MAX_TOOL_CALLS_PER_HOUR
 *      (use-case-wide cap, applies to every server allowlisted).
 *   3. Env GATEWAZE_MCP_MAX_TOOL_CALLS_PER_HOUR (instance default).
 *   4. No cap (unset everywhere → server loads regardless).
 *
 * Database-backed rather than Redis because the cost ledger is
 * authoritative and operators audit there. A Redis counter would be
 * faster but adds an eventually-consistent surface that can disagree
 * with the ledger. v1 trades a bit of latency for a single source of
 * truth.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = { from(table: string): any };

export interface RateLimitDecision {
  /** When true, the server should be loaded for this run. */
  allowed: boolean;
  /** Current count in the trailing hour. */
  count: number;
  /** Effective cap (Infinity if unset). */
  cap: number;
}

/**
 * Read the effective cap for (use case, mcp server) from
 * goose_runtime_overrides + env. Cheap — pulls one column from
 * ai_use_cases.
 */
export async function loadRateLimitCap(
  supabase: SupabaseLike,
  useCaseId: string,
  serverName: string,
): Promise<number> {
  // Sanitise per-server env-key suffix so the lookup matches what an
  // operator would type into the runtime-overrides editor.
  const perServerKey = `MCP_MAX_TOOL_CALLS_PER_HOUR_${serverName.toUpperCase().replace(/-/g, '_')}`;
  try {
    const res = await supabase
      .from('ai_use_cases')
      .select('goose_runtime_overrides')
      .eq('id', useCaseId)
      .maybeSingle();
    const overrides = ((res.data as { goose_runtime_overrides?: Record<string, unknown> } | null)?.goose_runtime_overrides) ?? {};
    const perServer = overrides[perServerKey];
    if (typeof perServer === 'number' && perServer > 0) return perServer;
    const generic = overrides.MCP_MAX_TOOL_CALLS_PER_HOUR;
    if (typeof generic === 'number' && generic > 0) return generic;
  } catch {
    // best-effort
  }
  const envCap = Number(process.env.GATEWAZE_MCP_MAX_TOOL_CALLS_PER_HOUR);
  if (Number.isFinite(envCap) && envCap > 0) return envCap;
  return Number.POSITIVE_INFINITY;
}

/**
 * Count ai_usage_events(kind='mcp_tool', provider=<server>, use_case=
 * <use_case>) in the trailing N seconds. Default window 3600s = 1 hour.
 */
export async function countRecentToolCalls(
  supabase: SupabaseLike,
  useCaseId: string,
  serverName: string,
  windowSeconds = 3600,
): Promise<number> {
  const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
  try {
    const res = await supabase
      .from('ai_usage_events')
      .select('id', { count: 'exact', head: true })
      .eq('use_case', useCaseId)
      .eq('kind', 'mcp_tool')
      .eq('provider', serverName)
      .gte('occurred_at', cutoff);
    return (res.count as number | null) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * One-stop call for the resolver: returns { allowed, count, cap }.
 * Unbounded caps short-circuit (no count query issued).
 */
export async function checkMcpRateLimit(
  supabase: SupabaseLike,
  useCaseId: string,
  serverName: string,
): Promise<RateLimitDecision> {
  const cap = await loadRateLimitCap(supabase, useCaseId, serverName);
  if (cap === Number.POSITIVE_INFINITY) {
    return { allowed: true, count: 0, cap };
  }
  const count = await countRecentToolCalls(supabase, useCaseId, serverName);
  return { allowed: count < cap, count, cap };
}
