/**
 * Dependency-free time formatting for the Runs view (issue #46). The module has no dayjs/date-fns
 * dependency and doesn't need one for two small formatters, so this stays hand-rolled rather than
 * pulling in a date library for the whole module.
 */

/** Absolute, locale-formatted timestamp — used as a tooltip alongside the relative label. */
export function formatAbsolute(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

/**
 * Human relative time, e.g. "2h ago". Falls back to the absolute date past 30 days, where a relative
 * label stops being useful. `now` is injectable so tests don't depend on the real clock.
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffSec = Math.max(0, Math.round((now - t) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatAbsolute(iso);
}
