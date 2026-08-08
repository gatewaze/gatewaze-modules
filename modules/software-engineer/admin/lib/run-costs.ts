/**
 * Per-run per-model cost aggregation for the run header (migration 018 data).
 *
 * Sources, in trust order per phase:
 *   1. model_usage — the SDK's per-model breakdown (subagents + harness utility models included;
 *      per-model costUSD present on completed phases; null costUSD on live heartbeat snapshots).
 *   2. cost_usd under the phase's own model — fallback for pre-018 phases with no breakdown.
 *
 * For live (heartbeat) snapshots whose per-model costUSD is null, the phase's estimated cost_usd
 * is attributed to the phase's primary model so the ticking total still adds up.
 */

export interface ModelCostRow { model: string; costUSD: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Short display label for a model id: 'claude-sonnet-5' → 'sonnet-5', 'gpt-5.2-codex' unchanged. */
export const shortModel = (m: string): string => m.replace(/^claude-/, '').replace(/-20\d{6}$/, '');

export function aggregateRunModelCosts(phases: Array<Record<string, unknown>>): { total: number; rows: ModelCostRow[] } {
  const perModel: Record<string, number> = {};
  let total = 0;
  for (const p of phases ?? []) {
    const phaseCost = Number(p?.cost_usd);
    const mu = (p?.model_usage ?? null) as Record<string, { costUSD?: number | null }> | null;
    if (mu && typeof mu === 'object' && Object.keys(mu).length) {
      const entries = Object.entries(mu);
      const withCost = entries.filter(([, u]) => typeof u?.costUSD === 'number' && (u.costUSD as number) > 0);
      if (withCost.length) {
        for (const [m, u] of withCost) perModel[m] = (perModel[m] ?? 0) + (u.costUSD as number);
        total += withCost.reduce((s, [, u]) => s + (u.costUSD as number), 0);
        continue;
      }
      // Live snapshot: tokens known, per-model cost not yet. A running row also has no `model`
      // column (set at phase end), so attribute the estimate to the DOMINANT model in the usage
      // map (by token volume) rather than falling through to 'unattributed'.
      if (Number.isFinite(phaseCost) && phaseCost > 0) {
        const dominant = entries
          .map(([m, u]: [string, any]) => [m, (u?.cacheRead ?? 0) + (u?.output ?? 0) + (u?.input ?? 0)] as [string, number])
          .sort((a, b) => b[1] - a[1])[0]?.[0];
        const m = dominant ?? String(p?.model ?? 'unattributed');
        perModel[m] = (perModel[m] ?? 0) + phaseCost;
        total += phaseCost;
      }
      continue;
    }
    if (Number.isFinite(phaseCost) && phaseCost > 0) {
      const m = String(p?.model ?? 'unattributed');
      perModel[m] = (perModel[m] ?? 0) + phaseCost;
      total += phaseCost;
    }
  }
  const rows = Object.entries(perModel)
    .map(([model, costUSD]) => ({ model, costUSD: r2(costUSD) }))
    .sort((a, b) => b.costUSD - a.costUSD);
  return { total: r2(total), rows };
}
