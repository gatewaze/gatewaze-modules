/**
 * Card → run-status mapping for the Overview tab's clickable KPI tiles (SPEC.md §14).
 *
 * This is a NON-COMPONENT module on purpose: OverviewView.tsx is a fast-refresh component file, and
 * `react-refresh/only-export-components` forbids value exports (maps, helpers) living beside a
 * component. Keeping the mapping here lets the component import it without forcing a full reload.
 *
 * The status sets are kept in lockstep with the se_overview() SQL function (migration
 * 007_overview_metrics.sql): each set below is exactly the `status in (...)` filter behind the
 * matching KPI tile, so clicking a tile opens the Runs board scoped to the same rows the tile
 * counts. overview-filters.test.ts pins each set so a SQL edit that drifts from here is caught.
 *
 * Only the four *count* tiles map to a run subset. Tokens and Avg-to-merge have no natural run
 * subset (they aggregate across runs), so they are intentionally absent and stay non-interactive.
 */

// se_overview() "active": live statuses (archived rows excluded server-side by the /runs board).
export const ACTIVE_STATUSES = ['queued', 'running', 'blocked', 'watching', 'changes_requested', 'pr_open'] as const;
// se_overview() "open_prs".
export const OPEN_PR_STATUSES = ['pr_open', 'watching', 'changes_requested'] as const;
// se_overview() "failed_blocked".
export const FAILED_STATUSES = ['failed', 'blocked'] as const;
// se_overview() "merged_30d" — note the 30-day window is NOT reproduced on the board (no date filter
// there), so the chip reads just "Merged". Documented nuance, not a bug.
export const MERGED_STATUSES = ['merged'] as const;

export type OverviewCardKey = 'active' | 'merged' | 'open_prs' | 'failed_blocked';

export interface OverviewCardFilter {
  /** Human label shown on the Runs-board filter chip. */
  label: string;
  /** Run statuses this card maps to (matches the se_overview() SQL filter). */
  statuses: readonly string[];
}

export const CARD_FILTERS: Record<OverviewCardKey, OverviewCardFilter> = {
  active: { label: 'Active', statuses: ACTIVE_STATUSES },
  merged: { label: 'Merged', statuses: MERGED_STATUSES },
  open_prs: { label: 'Open PRs', statuses: OPEN_PR_STATUSES },
  failed_blocked: { label: 'Failed / blocked', statuses: FAILED_STATUSES },
};

/** Serialise a status set into the `?status=` query param the /runs endpoint accepts. */
export function statusesToParam(statuses: readonly string[]): string {
  return statuses.join(',');
}

/**
 * Model spend for a run or rollup, priced from the ai module's price book at phase end
 * (se_runs.cost_usd, migration 012). Null/0/negative → '' so pre-012 rows and non-model runs
 * render nothing (never "$0.00"). Shared between SoftwareEngineerTab (runs list/detail) and
 * OverviewView (the spend KPI tile + per-project breakdown) so the format never drifts between them.
 */
export function fmtCost(c: unknown): string {
  const n = Number(c);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

/**
 * Reverse a `?status=` param back to a human label for the Runs-board chip. If the set matches a
 * known card exactly, use that card's label; otherwise fall back to the comma-joined statuses.
 */
export function filterLabelForParam(statusParam: string): string {
  const wanted = new Set(statusParam.split(',').map((s) => s.trim()).filter(Boolean));
  for (const card of Object.values(CARD_FILTERS)) {
    if (card.statuses.length === wanted.size && card.statuses.every((s) => wanted.has(s))) {
      return card.label;
    }
  }
  return [...wanted].join(', ');
}
