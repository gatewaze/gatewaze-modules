/**
 * PR-board formatting helpers — pure, React-free timestamp formatters used by
 * the Overview PR board (admin/components/PrBoard.tsx). Kept in `admin/lib/` so
 * they are unit-testable under the module's node vitest config (no jsdom),
 * mirroring `timeline.ts`. The component stays a thin view.
 */

/** Relative age of an ISO timestamp: minutes (floor 1m) → hours → days. */
export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * Absolute, human-readable date-time for a PR's original submission
 * (GitHub `created_at`) — e.g. `Jul 30, 2026, 2:14 PM`. Returns `''` for
 * empty/missing/unparseable input so the caller can guard rendering and never
 * shows "Invalid Date".
 */
export function formatSubmittedDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
