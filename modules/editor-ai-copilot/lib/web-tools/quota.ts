/**
 * Daily quota + cost-budget tracking for the AI chatbot tools.
 *
 * READ-ONLY against `ai_usage_events` from the @gatewaze-modules/ai
 * module. `readTodayUsage` sums today's rows filtered to
 * use_case='editor-ai-copilot' AND matching (provider, model), and the
 * pre-call gate (`shouldAllowToolCall`) decides whether the next call
 * fits the daily call-count + cost budget.
 *
 * This module does NOT write rows. The runner (@gatewaze-modules/ai's
 * runChat) is the single source of truth for tool spend: it records one
 * anthropic/web_search row per turn and one scrapling/fetch_url:fast row
 * per fetch, all tagged use_case='editor-ai-copilot'. An earlier
 * `bumpTodayUsage` writer here produced a SECOND, system-attributed row
 * per call, which double-counted tool spend on the usage dashboard and in
 * this gate's own reads. It was removed; the gate now reads the runner's
 * authoritative rows.
 *
 * If the ai module isn't on the runtime require-path (defensive — the
 * editor can boot standalone) readTodayUsage returns zero, so the gate
 * stays open and the editor still works (without per-tool containment).
 *
 * Spec §6.6 / §6.7 unchanged — same envvar names + defaults.
 */

const USE_CASE = 'editor-ai-copilot';

export interface SupabaseLikeRpc {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: any; error: any | null }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export type ToolName = 'web_search' | 'fetch_url';

export interface UsageSnapshot {
  callCount: number;
  costMicroUsd: number;
}

/**
 * Map an editor-side tool name to the ai_usage_events (provider, model)
 * tuple. Keeps the gate logic provider-agnostic from the caller's POV
 * while attribution stays accurate in the unified ledger.
 */
function toolToLedgerKey(tool: ToolName): { provider: string; model: string } {
  switch (tool) {
    case 'fetch_url':
      // Editor uses the internal scrapling-fetcher 'fast' tier.
      return { provider: 'scrapling', model: 'fetch_url:fast' };
    case 'web_search':
      // Anthropic-hosted server-side tool. Billed by Anthropic per
      // request; we tag rows with provider='anthropic', model='web_search'.
      return { provider: 'anthropic', model: 'web_search' };
  }
}

/**
 * Lazy-load the ai module's cost helpers. The editor module's runtime
 * require-path doesn't resolve sibling modules eagerly, so we defer
 * resolution to first call and cache it. Returns null if the ai module
 * isn't installed (fail-open).
 */
type AiCostModule = {
  sumTodayToolUsage: (
    supabase: SupabaseLikeRpc,
    args: { useCase: string; provider: string; model: string },
  ) => Promise<{ callCount: number; costMicroUsd: number }>;
};

let cachedAiCost: AiCostModule | null | undefined;
async function loadAiCost(): Promise<AiCostModule | null> {
  if (cachedAiCost !== undefined) return cachedAiCost;
  const attempts = [
    '@gatewaze-modules/ai/lib/cost.js',
    '../../../../../gatewaze-modules/modules/ai/lib/cost.ts',
  ];
  for (const path of attempts) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import(path)) as AiCostModule;
      if (typeof mod.sumTodayToolUsage === 'function') {
        cachedAiCost = mod;
        return cachedAiCost;
      }
    } catch {
      /* fall through */
    }
  }
  cachedAiCost = null;
  return null;
}

/**
 * Override the lazy-loaded ai-cost module. Used by tests to inject a
 * stub; passing `null` resets to the default lazy-load behaviour on
 * next call.
 */
export function __setAiCostModuleForTesting(mod: AiCostModule | null): void {
  cachedAiCost = mod ?? undefined;
}

/**
 * Inject the ai-cost module directly (production paths don't use this;
 * the lazy-load handles it). Tests pass a stub here to bypass the
 * dynamic import.
 */
export function injectAiCostModuleForTesting(mod: AiCostModule): void {
  cachedAiCost = mod;
}

/**
 * Read today's usage for a tool. Returns zero if no rows exist yet OR
 * if the ai module isn't installed (fail-open).
 */
export async function readTodayUsage(
  supabase: SupabaseLikeRpc,
  tool: ToolName,
): Promise<UsageSnapshot> {
  const ai = await loadAiCost();
  if (!ai) return { callCount: 0, costMicroUsd: 0 };
  const key = toolToLedgerKey(tool);
  try {
    const result = await ai.sumTodayToolUsage(supabase, {
      useCase: USE_CASE,
      provider: key.provider,
      model: key.model,
    });
    return { callCount: result.callCount, costMicroUsd: result.costMicroUsd };
  } catch {
    // Failing read shouldn't block the editor. Treat as zero — the
    // gate stays open. Operator notices via missing data in the
    // /admin/ai/usage dashboard.
    return { callCount: 0, costMicroUsd: 0 };
  }
}

export interface QuotaPolicy {
  /** Max calls per day for this tool. 0 = unlimited. */
  dailyMaxCalls: number;
  /**
   * Daily cost budget across BOTH tools, in micro-USD (1c = 10_000).
   * Both tools share one budget — exhausting it strips both from the
   * tools array. null = no cap.
   */
  dailyCostBudgetMicroUsd: number | null;
}

/**
 * Decide whether a tool's next call would breach quota or budget.
 * Pre-call gate — returns ok:false to strip the tool from the array
 * before the request reaches Anthropic.
 */
export function shouldAllowToolCall(
  usage: UsageSnapshot,
  policy: QuotaPolicy,
  combinedCostMicroUsd: number,
  estimatedCostMicroUsd: number,
): { ok: true } | { ok: false; reason: 'quota_exceeded' | 'cost_budget_exceeded' } {
  if (policy.dailyMaxCalls > 0 && usage.callCount >= policy.dailyMaxCalls) {
    return { ok: false, reason: 'quota_exceeded' };
  }
  if (
    policy.dailyCostBudgetMicroUsd !== null &&
    combinedCostMicroUsd + estimatedCostMicroUsd > policy.dailyCostBudgetMicroUsd
  ) {
    return { ok: false, reason: 'cost_budget_exceeded' };
  }
  return { ok: true };
}

/** Cost estimates per call. Spec §6.7 defers exact pricing to deployment-time config. */
export interface CostEstimate {
  webSearchMicroUsdPerCall: number;
  fetchUrlMicroUsdPerCall: number;
}
