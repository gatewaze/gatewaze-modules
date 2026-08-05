// @ts-nocheck
/**
 * Phase cost pricing. Source of truth is the ai module's operator-editable price book
 * (public.ai_model_prices — litellm-refreshed, effective_from-versioned), read directly with the
 * worker's service-role client rather than via cross-module import (see resources/lib/
 * resolve-ai-module.ts for why dynamic module imports are a last resort). The compute mirrors
 * modules/ai/lib/cost.ts `computeCostMicroUsd` exactly so SE run costs agree with the platform's
 * AI usage dashboards: cache-creation falls back to the input rate when the book has no dedicated
 * rate; a null cached rate charges cache reads at 0 (the book's "no cache discount" contract).
 *
 * Returns null when the model has no price-book row — callers fall back to the Agent SDK's own
 * total_cost_usd, which is computed at Anthropic list prices.
 */

export interface PhaseUsage {
  input: number;         // uncached input tokens (usage.input_tokens)
  output: number;
  cacheRead: number;     // usage.cache_read_input_tokens
  cacheCreation: number; // usage.cache_creation_input_tokens
}

export async function pricePhaseCostUSD(
  sb: unknown,
  model: string,
  usage: PhaseUsage,
  opts: { provider?: 'anthropic' | 'openai'; occurredAt?: Date } = {},
): Promise<number | null> {
  const occurredAt = opts.occurredAt ?? new Date();
  if (!model) return null;
  const { data } = await sb
    .from('ai_model_prices')
    .select('input_per_million_usd, output_per_million_usd, cached_per_million_usd, cache_creation_per_million_usd')
    .eq('provider', opts.provider ?? 'anthropic')
    .eq('model', model)
    .lte('effective_from', occurredAt.toISOString().slice(0, 10))
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  // 1 token at $X/MTok = X micro-USD, so tokens * rate yields micro-USD directly.
  const cacheCreationRate = data.cache_creation_per_million_usd ?? data.input_per_million_usd;
  const micros =
    Math.round((usage.input ?? 0) * (data.input_per_million_usd ?? 0)) +
    Math.round((usage.output ?? 0) * (data.output_per_million_usd ?? 0)) +
    (data.cached_per_million_usd ? Math.round((usage.cacheRead ?? 0) * data.cached_per_million_usd) : 0) +
    Math.round((usage.cacheCreation ?? 0) * (cacheCreationRate ?? 0));
  return Math.round(micros / 100) / 10000; // micro-USD → USD at 4dp (matches cost_usd numeric(10,4))
}

export interface ProjectSpend {
  project_id: string;
  name: string | null;
  avatar_emoji: string | null;
  total: number;
}

export interface SpendOverview {
  total_30d: number;
  total_7d: number;
  by_project: ProjectSpend[];
}

/**
 * Best-effort spend rollup for the Overview tab, run alongside (never inside) se_overview(). Costs
 * are bucketed by se_runs.created_at — a proxy for when the spend actually happened, not per-phase
 * precision — which is an accepted approximation for a KPI tile.
 *
 * Returns null on ANY failure, including a pre-012 instance where se_runs.cost_usd doesn't exist
 * yet: the whole body is wrapped in try/catch (not just an {error} check) so a client that throws
 * synchronously (e.g. no .from() at all) degrades exactly like a clean PostgREST error. Callers
 * omit the `spend` key on null so the rest of the Overview payload is unaffected.
 */
export async function computeSpendOverview(sb: unknown, projectId: string | null): Promise<SpendOverview | null> {
  try {
    const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const since7 = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    let q = (sb as any).from('se_runs')
      .select('cost_usd, created_at, project_id, project:se_projects(name, avatar_emoji)')
      .not('cost_usd', 'is', null)
      .gte('created_at', since30);
    if (projectId) q = q.eq('project_id', projectId);
    const { data, error } = await q;
    if (error || !data) return null;

    let total30 = 0;
    let total7 = 0;
    const byProject = new Map<string, ProjectSpend>();
    for (const r of data as any[]) {
      const cost = Number(r.cost_usd);
      if (!Number.isFinite(cost)) continue;
      total30 += cost;
      if (r.created_at >= since7) total7 += cost;
      if (r.project_id) {
        const proj = Array.isArray(r.project) ? r.project[0] : r.project;
        const cur = byProject.get(r.project_id) ?? {
          project_id: r.project_id,
          name: proj?.name ?? null,
          avatar_emoji: proj?.avatar_emoji ?? null,
          total: 0,
        };
        cur.total += cost;
        byProject.set(r.project_id, cur);
      }
    }
    return {
      total_30d: Math.round(total30 * 10000) / 10000,
      total_7d: Math.round(total7 * 10000) / 10000,
      by_project: [...byProject.values()].sort((a, b) => b.total - a.total),
    };
  } catch {
    return null;
  }
}
