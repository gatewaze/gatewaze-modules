/**
 * Pure logic behind the Environments log explorer (EnvLogExplorer.tsx) — time
 * ranges, consecutive-event collapsing, and row presentation. Split from the
 * component for the same reason as envCards.ts / autoscroll.ts: it unit-tests
 * under vitest's node environment and it keeps the component file free of
 * value exports that would break fast refresh.
 *
 * NOTHING here touches the network or `supabase` (that is testEnv.ts), so the
 * whole file is importable from a plain node test.
 */
import { KIND_GROUPS, kindLabel, kindCount, kindSeverity, isErrorKind } from '../../lib/env-event-kinds.js';
import type { EventSeverity } from '../../lib/env-event-kinds.js';

export interface LogEvent {
  id: number;
  ts: string;
  kind: string;
  env_label: string | null;
  detail: string | null;
  meta: Record<string, unknown> | null;
}

// ── time ranges ──────────────────────────────────────────────────────────────

export const TIME_RANGES: { key: string; label: string; ms: number | null }[] = [
  { key: '15m', label: '15m', ms: 15 * 60_000 },
  { key: '1h', label: '1h', ms: 60 * 60_000 },
  { key: '24h', label: '24h', ms: 24 * 60 * 60_000 },
  { key: 'all', label: 'All', ms: null },
  { key: 'custom', label: 'Custom', ms: null },
];

export interface Window { since: string | null; until: string | null }

/**
 * Resolve a range key (+ optional custom bounds, as `datetime-local` strings
 * or ISO instants) into the `since`/`until` the API takes. "all" is an
 * unbounded window; a custom range with unparseable bounds degrades to
 * unbounded rather than erroring the panel.
 */
export function rangeWindow(key: string, now: number, custom?: { from?: string; to?: string }): Window {
  if (key === 'custom') {
    const iso = (v?: string) => {
      if (!v) return null;
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    };
    return { since: iso(custom?.from), until: iso(custom?.to) };
  }
  const spec = TIME_RANGES.find((r) => r.key === key);
  if (!spec || spec.ms === null) return { since: null, until: null };
  return { since: new Date(now - spec.ms).toISOString(), until: null };
}

/** Bounded window for the summary strip — "all" still needs two ends to bucket. */
export function summaryWindow(w: Window, now: number, fallbackMs = 24 * 60 * 60_000): { from: string; to: string } {
  const to = w.until ?? new Date(now).toISOString();
  const from = w.since ?? new Date(Date.parse(to) - fallbackMs).toISOString();
  return { from, to };
}

// ── kind filter groups ───────────────────────────────────────────────────────

/** The chip row: a group name → the kinds it selects. `all` clears the filter. */
export const KIND_FILTER_GROUPS: { key: string; label: string; kinds: string[] | null }[] = [
  { key: 'all', label: 'All', kinds: null },
  { key: 'lifecycle', label: 'Lifecycle', kinds: KIND_GROUPS.lifecycle },
  { key: 'access', label: 'Access', kinds: KIND_GROUPS.access },
  { key: 'errors', label: 'Errors', kinds: KIND_GROUPS.errors },
];

/**
 * Resolve the chip selection + any individually-ticked kinds into the `kind`
 * query param. Individually-ticked kinds win outright (the group chip is a
 * shortcut for populating them, not an extra constraint).
 */
export function kindParam(group: string, picked: string[]): string | undefined {
  if (picked.length > 0) return [...new Set(picked)].join(',');
  const g = KIND_FILTER_GROUPS.find((x) => x.key === group);
  return g?.kinds ? g.kinds.join(',') : undefined;
}

// ── presentation ─────────────────────────────────────────────────────────────

/** Tailwind classes per severity, matching the admin design system's tokens. */
export const SEVERITY_STYLE: Record<EventSeverity, { badge: string; row: string; dot: string }> = {
  error: {
    badge: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
    row: 'bg-red-500/[0.06] hover:bg-red-500/[0.12]',
    dot: 'bg-red-500',
  },
  warn: {
    badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
    row: 'hover:bg-[var(--gray-3)]',
    dot: 'bg-amber-500',
  },
  ok: {
    badge: 'bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30',
    row: 'hover:bg-[var(--gray-3)]',
    dot: 'bg-green-500',
  },
  info: {
    badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
    row: 'hover:bg-[var(--gray-3)]',
    dot: 'bg-blue-500',
  },
  muted: {
    badge: 'bg-[var(--gray-4)] text-[var(--gray-11)] border-[var(--gray-6)]',
    row: 'hover:bg-[var(--gray-3)]',
    dot: 'bg-[var(--gray-8)]',
  },
};

export const severityStyle = (kind: string) => SEVERITY_STYLE[kindSeverity(kind)] ?? SEVERITY_STYLE.info;

/** HH:MM:SS in the viewer's locale — monospace clock column. */
export function fmtClock(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return '--:--:--';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "14:02–14:19" for a collapsed run; a single clock when the run is instant. */
export function fmtSpan(fromTs: string, toTs: string): string {
  const a = fmtClock(fromTs).slice(0, 5);
  const b = fmtClock(toTs).slice(0, 5);
  return a === b ? a : `${a}–${b}`;
}

/** Compact relative age ("3s", "12m", "4h", "2d"), stable for a log column. */
export function fmtAge(ts: string, now: number): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

// ── consecutive-run collapsing ───────────────────────────────────────────────

/**
 * Kinds worth collapsing: the high-frequency, individually-uninteresting ones.
 * Lifecycle events are deliberately NOT here — every `create`/`ready`/`fail`
 * is a distinct decision an operator wants to see on its own line.
 */
export const COLLAPSIBLE_KINDS = new Set(['visit', 'login_success', 'login_failure', 'service_error', 'root_reassert']);

/** The meta key that best identifies "who/what" for a given kind. */
export const FACET_KEY: Record<string, { key: string; noun: string }> = {
  visit: { key: 'host', noun: 'host' },
  login_success: { key: 'username', noun: 'user' },
  login_failure: { key: 'username', noun: 'user' },
  service_error: { key: 'service', noun: 'service' },
};

export interface LogGroup {
  key: string;
  kind: string;
  env_label: string | null;
  /** Number of source rows folded in (1 = a plain row). */
  count: number;
  /** Sum of any per-event `meta.count` (the tailers pre-bucket), else `count`. */
  weight: number;
  /** Oldest and newest member timestamps. */
  from_ts: string;
  to_ts: string;
  /** Distinct facet values across the run (hosts / usernames / services). */
  facets: string[];
  facetNoun: string | null;
  severity: EventSeverity;
  members: LogEvent[];
  /** The row rendered when collapsed — the newest member. */
  head: LogEvent;
}

const facetOf = (e: LogEvent): string | null => {
  const f = FACET_KEY[e.kind];
  if (!f || !e.meta || typeof e.meta !== 'object') return null;
  const v = (e.meta as Record<string, unknown>)[f.key];
  return typeof v === 'string' && v ? v.slice(0, 80) : null;
};

const weightOf = (e: LogEvent): number => {
  const c = e.meta && typeof e.meta === 'object' ? (e.meta as Record<string, unknown>).count : undefined;
  return Number.isInteger(c) && (c as number) > 0 ? (c as number) : 1;
};

/**
 * Fold consecutive same-kind, same-env events into one expandable group.
 *
 * Input MUST be newest-first (the order the API returns). Two events join the
 * same run when they share kind + env_label, the kind is collapsible, and they
 * are within `windowMs` of each other — so a burst of visits becomes one row
 * while the same env's visits an hour later stay separate. A run of one is
 * emitted as a plain row (count 1), so the caller renders groups uniformly.
 */
export function groupEvents(
  events: LogEvent[],
  { windowMs = 15 * 60_000, enabled = true }: { windowMs?: number; enabled?: boolean } = {},
): LogGroup[] {
  const out: LogGroup[] = [];
  const single = (e: LogEvent): LogGroup => ({
    key: `e${e.id}`,
    kind: e.kind,
    env_label: e.env_label,
    count: 1,
    weight: weightOf(e),
    from_ts: e.ts,
    to_ts: e.ts,
    facets: [facetOf(e)].filter((x): x is string => !!x),
    facetNoun: FACET_KEY[e.kind]?.noun ?? null,
    severity: kindSeverity(e.kind),
    members: [e],
    head: e,
  });

  for (const e of events) {
    if (!enabled || !COLLAPSIBLE_KINDS.has(e.kind)) { out.push(single(e)); continue; }
    const prev = out[out.length - 1];
    const joinable = prev
      && prev.kind === e.kind
      && prev.env_label === e.env_label
      && COLLAPSIBLE_KINDS.has(prev.kind)
      // Newest-first: `e` is older than the run's current oldest member.
      && Math.abs(Date.parse(prev.from_ts) - Date.parse(e.ts)) <= windowMs;
    if (!joinable) { out.push(single(e)); continue; }
    prev.count += 1;
    prev.weight += weightOf(e);
    prev.from_ts = e.ts;
    prev.members.push(e);
    const f = facetOf(e);
    if (f && !prev.facets.includes(f)) prev.facets.push(f);
    prev.key = `g${prev.head.id}-${prev.count}`;
  }
  return out;
}

/** "12 visits · 3 hosts · 14:02–14:19" for a collapsed run. */
export function groupSummaryText(g: LogGroup): string {
  const parts = [kindCount(g.kind, g.weight)];
  if (g.facets.length > 1 && g.facetNoun) {
    parts.push(`${g.facets.length} ${g.facetNoun}${g.facets.length === 1 ? '' : 's'}`);
  } else if (g.facets.length === 1) {
    parts.push(g.facets[0]);
  }
  parts.push(fmtSpan(g.from_ts, g.to_ts));
  return parts.join(' · ');
}

/** Related events for the drill-down: same env, within ±`ms` of the anchor. */
export function relatedEvents(all: LogEvent[], anchor: LogEvent, ms = 5 * 60_000): LogEvent[] {
  const t = Date.parse(anchor.ts);
  if (Number.isNaN(t)) return [];
  return all.filter((e) => e.id !== anchor.id
    && e.env_label === anchor.env_label
    && Math.abs(Date.parse(e.ts) - t) <= ms);
}

export { kindLabel, kindCount, kindSeverity, isErrorKind };
