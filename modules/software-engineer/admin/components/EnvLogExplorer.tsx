// @ts-nocheck
/**
 * Environment log explorer — the Overview "Environments" activity/errors view.
 *
 * Replaces the 50-row unpaged timeline from #213, which was unusable the
 * moment the host tailers started producing real volume. This is a proper log
 * explorer over se_env_events:
 *
 *   · filters — env multi-select (every env the log has ever mentioned, torn
 *     down and reaped included, plus the unattributed shared-Authelia events),
 *     kind groups (lifecycle / access / errors) with an expandable per-kind
 *     picker, a time range (15m / 1h / 24h / all / custom), and free text over
 *     `detail`. All of it lives in the URL (log_* params) so a filtered view is
 *     shareable and survives a reload, matching the runs board's project/status
 *     convention in SoftwareEngineerTab.tsx.
 *   · density — one compact line per event, monospace clock, relative age on
 *     the right, absolute ISO on hover. Consecutive same-kind/same-env bursts
 *     collapse into one expandable row ("42 visits · 3 hosts · 14:02–14:19").
 *   · drill-down — click a row for the full untruncated detail, the whole meta
 *     payload (service_error carries the collector's span attributes there),
 *     and the same env's other events within ±5 minutes.
 *   · live tail — polls on the freshness cadence and prepends new rows with a
 *     fading highlight. The list is newest-FIRST (so "load older" is the
 *     natural page action), which makes "pinned to the bottom" mean pinned to
 *     the newest — the top. It unpins the moment the reader scrolls away and
 *     re-pins when they come back, reusing the runs-transcript threshold.
 *   · summary strip — per-env counts for the window with an activity sparkline;
 *     errors are the number that shouts.
 *
 * Volume safety is server-side: GET /test-env/env-events is keyset-paged
 * (newest-first on (ts, id)), capped page size, and the summary scan is capped
 * too. Retention is enforced from the ingest path (lib/env-events.ts).
 *
 * Admin design system (Tailwind + Radix gray vars); no @radix-ui/themes import
 * (module Radix-singleton hazard). Every event field is rendered as React text
 * — never dangerouslySetInnerHTML — because env labels, Authelia usernames and
 * collector span messages all originate outside this codebase.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui';
import {
  ArrowPathIcon, MagnifyingGlassIcon, PlayIcon, PauseIcon, XMarkIcon,
  ChevronRightIcon, ChevronDownIcon, ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { fetchEnvEvents, fetchEnvEventSummary } from './testEnv';
import { PIN_THRESHOLD_PX } from './autoscroll';
import {
  TIME_RANGES, KIND_FILTER_GROUPS, rangeWindow, summaryWindow, kindParam,
  groupEvents, groupSummaryText, relatedEvents, severityStyle,
  fmtClock, fmtAge, kindLabel,
} from './envLog';
import { KIND_GROUPS } from '../../lib/env-event-kinds.js';

const PAGE_SIZE = 150;
const TAIL_MS = 6000;          // same cadence the panel uses while something is live
const SUMMARY_MS = 30_000;     // the strip is a rollup — it does not need tail cadence
const HIGHLIGHT_MS = 2500;
const NO_ENV = 'none';
const ALL_KINDS = [...new Set([...KIND_GROUPS.lifecycle, ...KIND_GROUPS.access, ...KIND_GROUPS.errors])].sort();

// ── URL state ────────────────────────────────────────────────────────────────
// Namespaced log_* so the explorer can never collide with the runs board's
// project/status params living on the same location.
const PARAMS = { env: 'log_env', kind: 'log_kind', group: 'log_group', range: 'log_range', q: 'log_q', from: 'log_from', to: 'log_to', tail: 'log_tail', collapse: 'log_collapse' };

function useLogFilters() {
  const [sp, setSp] = useSearchParams();
  const get = (k, dflt = '') => sp.get(k) ?? dflt;
  const patch = useCallback((changes) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) {
        if (v === '' || v === null || v === undefined) next.delete(k);
        else next.set(k, String(v));
      }
      return next;
    }, { replace: true });
  }, [setSp]);
  return {
    envs: get(PARAMS.env).split(',').filter(Boolean),
    kinds: get(PARAMS.kind).split(',').filter(Boolean),
    group: get(PARAMS.group, 'all'),
    range: get(PARAMS.range, '1h'),
    q: get(PARAMS.q),
    from: get(PARAMS.from),
    to: get(PARAMS.to),
    tail: get(PARAMS.tail) === '1',
    collapse: get(PARAMS.collapse) !== '0',
    patch,
  };
}

// ── sparkline ────────────────────────────────────────────────────────────────
function Sparkline({ total, errors, width = 220, height = 26 }) {
  const n = total?.length ?? 0;
  if (!n) return null;
  const peak = Math.max(1, ...total);
  const bw = width / n;
  return (
    <svg width={width} height={height} role="img" aria-label={`Activity over the window, peak ${peak} events per bucket`} className="shrink-0">
      {total.map((v, i) => {
        const h = Math.max(v > 0 ? 1 : 0, Math.round((v / peak) * height));
        const e = errors?.[i] ?? 0;
        const eh = Math.max(e > 0 ? 1 : 0, Math.round((e / peak) * height));
        return (
          <g key={i}>
            <rect x={i * bw} y={height - h} width={Math.max(1, bw - 1)} height={h} className="fill-[var(--gray-7)]" />
            {eh > 0 && <rect x={i * bw} y={height - eh} width={Math.max(1, bw - 1)} height={eh} className="fill-red-500" />}
          </g>
        );
      })}
    </svg>
  );
}

// ── at-a-glance strip ────────────────────────────────────────────────────────
function SummaryStrip({ summary, onPickEnv }) {
  if (!summary) return null;
  const t = summary.totals ?? {};
  const rows = (summary.per_env ?? []).slice(0, 6);
  return (
    <div className="rounded-md border border-[var(--gray-5)] bg-[var(--gray-2)] px-2.5 py-2">
      <div className="flex items-center gap-3 flex-wrap">
        <Sparkline total={summary.sparkline} errors={summary.error_sparkline} />
        <div className="flex items-center gap-3 text-[11px]">
          <Stat label="events" value={t.total ?? 0} />
          <Stat label="visits" value={t.visits ?? 0} />
          <Stat label="logins" value={t.logins ?? 0} sub={t.login_failures ? `${t.login_failures} failed` : null} subTone="amber" />
          <Stat label="lifecycle" value={t.lifecycle ?? 0} />
          <div className={`rounded px-2 py-1 ${t.errors ? 'bg-red-500/15 border border-red-500/40' : 'border border-transparent'}`}>
            <div className={`font-semibold tabular-nums ${t.errors ? 'text-base text-red-600 dark:text-red-400' : 'text-[var(--gray-11)]'}`}>
              {t.errors ?? 0}
            </div>
            <div className={t.errors ? 'text-red-700 dark:text-red-300' : 'text-[var(--gray-10)]'}>
              {t.errors ? <ExclamationTriangleIcon className="size-3 inline mr-0.5 -mt-0.5" /> : null}errors
            </div>
          </div>
        </div>
        {summary.truncated && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400" title="More events matched than the summary scan cap — counts are a floor, not a total">
            counts capped
          </span>
        )}
      </div>
      {rows.length > 1 && (
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[10px]">
          {rows.map((r) => (
            <button
              key={r.env ?? NO_ENV}
              onClick={() => onPickEnv(r.env ?? NO_ENV)}
              title={`Filter the log to ${r.env ?? 'events with no environment'}`}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-[var(--gray-3)] ${r.errors ? 'border-red-500/40' : 'border-[var(--gray-5)]'}`}
            >
              <span className="font-mono text-[var(--gray-11)]">{r.env ?? '(no env)'}</span>
              <span className="text-[var(--gray-10)] tabular-nums">{r.total}</span>
              {r.errors > 0 && <span className="text-red-600 dark:text-red-400 tabular-nums font-medium">{r.errors} err</span>}
              {r.login_failures > 0 && <span className="text-amber-600 dark:text-amber-400 tabular-nums">{r.login_failures} auth</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const Stat = ({ label, value, sub, subTone }) => (
  <div className="px-1">
    <div className="font-semibold tabular-nums text-[var(--gray-12)]">{value}</div>
    <div className="text-[var(--gray-10)]">
      {label}
      {sub && <span className={subTone === 'amber' ? ' text-amber-600 dark:text-amber-400' : ''}> · {sub}</span>}
    </div>
  </div>
);

// ── one log row (a group of 1..N events) ─────────────────────────────────────
function LogRow({ g, now, selectedId, onSelect, isNew }) {
  const [open, setOpen] = useState(false);
  const collapsed = g.count > 1;
  const sty = severityStyle(g.kind);
  const head = g.head;
  const selected = selectedId === head.id;
  return (
    <>
      <div
        className={`group flex items-baseline gap-2 px-1.5 py-[3px] rounded-sm cursor-pointer border-l-2 ${sty.row}
          ${selected ? 'bg-[var(--gray-4)] border-l-blue-500' : 'border-l-transparent'}
          ${isNew ? 'animate-pulse bg-blue-500/10' : ''}`}
        onClick={() => onSelect(head)}
      >
        <span className="w-16 shrink-0 font-mono text-[10px] text-[var(--gray-10)] tabular-nums" title={head.ts}>
          {collapsed ? fmtClock(g.to_ts) : fmtClock(head.ts)}
        </span>
        <span className={`inline-block size-1.5 rounded-full shrink-0 translate-y-[-1px] ${sty.dot}`} aria-hidden />
        <span className={`shrink-0 rounded border px-1 text-[10px] leading-4 ${sty.badge}`}>{kindLabel(g.kind)}</span>
        {g.env_label
          ? <span className="shrink-0 font-mono text-[10px] text-[var(--gray-11)]">{g.env_label}</span>
          : <span className="shrink-0 text-[10px] text-[var(--gray-9)] italic">shared</span>}
        {collapsed ? (
          <button
            onClick={(ev) => { ev.stopPropagation(); setOpen((o) => !o); }}
            className="inline-flex items-center gap-0.5 text-[11px] text-[var(--gray-11)] hover:text-[var(--gray-12)] min-w-0"
            title={`${g.count} events folded — click to expand`}
          >
            {open ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />}
            <span className="truncate">{groupSummaryText(g)}</span>
          </button>
        ) : (
          <span className="text-[11px] text-[var(--gray-11)] truncate min-w-0">{head.detail}</span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--gray-9)] tabular-nums" title={head.ts}>
          {fmtAge(head.ts, now)}
        </span>
      </div>
      {collapsed && open && g.members.map((m) => (
        <div key={m.id} onClick={() => onSelect(m)}
          className={`flex items-baseline gap-2 pl-8 pr-1.5 py-[2px] rounded-sm cursor-pointer hover:bg-[var(--gray-3)] ${selectedId === m.id ? 'bg-[var(--gray-4)]' : ''}`}>
          <span className="w-16 shrink-0 font-mono text-[10px] text-[var(--gray-10)] tabular-nums" title={m.ts}>{fmtClock(m.ts)}</span>
          <span className="text-[11px] text-[var(--gray-11)] truncate min-w-0">{m.detail}</span>
        </div>
      ))}
    </>
  );
}

// ── drill-down ───────────────────────────────────────────────────────────────
function DetailPanel({ event, all, onClose }) {
  if (!event) return null;
  const related = relatedEvents(all, event);
  const meta = event.meta && typeof event.meta === 'object' ? event.meta : null;
  return (
    <aside className="rounded-md border border-[var(--gray-5)] bg-[var(--gray-2)] p-2.5 text-[11px] lg:w-96 lg:shrink-0 lg:max-h-[28rem] lg:overflow-y-auto">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`rounded border px-1 text-[10px] leading-4 ${severityStyle(event.kind).badge}`}>{kindLabel(event.kind)}</span>
            {event.env_label && <span className="font-mono text-[10px] text-[var(--gray-11)]">{event.env_label}</span>}
          </div>
          <div className="mt-1 font-mono text-[10px] text-[var(--gray-10)]">{event.ts}</div>
        </div>
        <button onClick={onClose} className="ml-auto text-[var(--gray-10)] hover:text-[var(--gray-12)]" aria-label="Close detail">
          <XMarkIcon className="size-4" />
        </button>
      </div>
      {/* Untruncated — the row list clips, this never does. */}
      <div className="mt-2 whitespace-pre-wrap break-words rounded border border-[var(--gray-5)] bg-[var(--gray-1)] p-2 font-mono text-[10px] text-[var(--gray-12)]">
        {event.detail || '(no detail)'}
      </div>
      {meta && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-[var(--gray-10)]">
            {event.kind === 'service_error' ? 'Collector payload' : 'Metadata'}
          </div>
          <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-5)] bg-[var(--gray-1)] p-2 font-mono text-[10px] text-[var(--gray-12)]">
            {JSON.stringify(meta, null, 2)}
          </pre>
        </div>
      )}
      <div className="mt-2">
        <div className="text-[10px] uppercase tracking-wide text-[var(--gray-10)]">
          Around this event {event.env_label ? `· ${event.env_label}` : '· no env'} · ±5 min
        </div>
        {related.length === 0 ? (
          <div className="mt-1 text-[var(--gray-10)]">Nothing else in the loaded window.</div>
        ) : (
          <div className="mt-1 flex flex-col gap-0.5">
            {related.slice(0, 40).map((r) => (
              <div key={r.id} className="flex items-baseline gap-1.5">
                <span className="font-mono text-[10px] text-[var(--gray-10)] tabular-nums">{fmtClock(r.ts)}</span>
                <span className={`shrink-0 rounded border px-1 text-[10px] leading-4 ${severityStyle(r.kind).badge}`}>{kindLabel(r.kind)}</span>
                <span className="truncate text-[var(--gray-11)]">{r.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

// ── the explorer ─────────────────────────────────────────────────────────────
export default function EnvLogExplorer({ envLabels = [], now }) {
  const f = useLogFilters();
  const [events, setEvents] = useState(null);   // null = endpoint unavailable / not loaded yet
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [older, setOlder] = useState(false);
  const [selected, setSelected] = useState(null);
  const [kindPicker, setKindPicker] = useState(false);
  const [fresh, setFresh] = useState(() => new Set());
  const [search, setSearch] = useState(f.q);
  const listRef = useRef(null);
  const loadedRef = useRef(false);    // one successful load = the endpoint exists
  const pinRef = useRef(true);        // "keep me on the newest row"
  const seenRef = useRef(new Set());  // ids already rendered (so the tail knows what is new)

  // Debounce the search box into the URL (and therefore into the query).
  useEffect(() => {
    const t = setTimeout(() => { if (search !== f.q) f.patch({ [PARAMS.q]: search }); }, 350);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const win = useMemo(() => rangeWindow(f.range, now ?? Date.now(), { from: f.from, to: f.to }),
    // `now` ticks every 10s; re-deriving the window on every tick would refetch
    // forever. Anchor it to the filter identity instead and let the tail poll
    // bring in new rows.
    [f.range, f.from, f.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const baseQuery = useMemo(() => ({
    ...(f.envs.length ? { env: f.envs.join(',') } : {}),
    ...(kindParam(f.group, f.kinds) ? { kind: kindParam(f.group, f.kinds) } : {}),
    ...(f.q ? { q: f.q } : {}),
    ...(win.since ? { since: win.since } : {}),
    ...(win.until ? { until: win.until } : {}),
  }), [f.envs.join(','), f.kinds.join(','), f.group, f.q, win.since, win.until]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchEnvEvents({ ...baseQuery, limit: PAGE_SIZE });
      const list = r?.events ?? [];
      seenRef.current = new Set(list.map((e) => e.id));
      setEvents(list);
      setCursor(r?.next_cursor ?? null);
      setHasMore(!!r?.has_more);
      setFresh(new Set());
      loadedRef.current = true;
    } catch {
      // A transient failure must not tear the explorer (and the reader's
      // filters) off the page — only a never-succeeded endpoint hides it,
      // which is how a deployment without migration 025/026 stays quiet.
      if (!loadedRef.current) setEvents(null);
    } finally { setLoading(false); }
  }, [baseQuery]);

  const loadSummary = useCallback(async () => {
    const w = summaryWindow(win, now ?? Date.now());
    try {
      const r = await fetchEnvEventSummary({ ...baseQuery, since: w.from, until: w.to, buckets: 60 });
      setSummary(r?.summary ?? null);
    } catch { setSummary(null); }
  }, [baseQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); loadSummary(); }, [load, loadSummary]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) loadSummary(); }, SUMMARY_MS);
    return () => clearInterval(t);
  }, [loadSummary]);

  // Live tail: fetch the head of the SAME query and prepend whatever is new.
  useEffect(() => {
    if (!f.tail) return undefined;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await fetchEnvEvents({ ...baseQuery, limit: PAGE_SIZE });
        const incoming = (r?.events ?? []).filter((e) => !seenRef.current.has(e.id));
        if (incoming.length === 0) return;
        for (const e of incoming) seenRef.current.add(e.id);
        setEvents((prev) => [...incoming, ...(prev ?? [])]);
        setFresh(new Set(incoming.map((e) => e.id)));
        if (pinRef.current && listRef.current) listRef.current.scrollTop = 0;
      } catch { /* transient — the next tick retries */ }
    };
    const t = setInterval(tick, TAIL_MS);
    return () => clearInterval(t);
  }, [f.tail, baseQuery]);

  // Fade the "new row" highlight so a quiet log doesn't stay lit forever.
  useEffect(() => {
    if (fresh.size === 0) return undefined;
    const t = setTimeout(() => setFresh(new Set()), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [fresh]);

  const loadOlder = async () => {
    if (!cursor) return;
    setOlder(true);
    try {
      const r = await fetchEnvEvents({ ...baseQuery, ...cursor, limit: PAGE_SIZE });
      const list = r?.events ?? [];
      for (const e of list) seenRef.current.add(e.id);
      setEvents((prev) => [...(prev ?? []), ...list]);
      setCursor(r?.next_cursor ?? null);
      setHasMore(!!r?.has_more);
    } catch { /* leave the cursor alone — the button can be retried */ }
    finally { setOlder(false); }
  };

  // The list is newest-first, so "tail the newest" means pinned to the TOP. The
  // pin drops the moment the reader scrolls into scrollback and comes back when
  // they return, using the same slack the runs transcript uses.
  const onScroll = (e) => { pinRef.current = e.currentTarget.scrollTop <= PIN_THRESHOLD_PX; };

  const groups = useMemo(() => groupEvents(events ?? [], { enabled: f.collapse }), [events, f.collapse]);
  // Every env the LOG knows about, not just the live registry — a torn-down or
  // reaped env is exactly the one you want to read the history of.
  const envOptions = useMemo(() => {
    const s = new Set(envLabels);
    for (const r of summary?.per_env ?? []) if (r.env) s.add(r.env);
    for (const e of events ?? []) if (e.env_label) s.add(e.env_label);
    return [...s].sort();
  }, [envLabels, summary, events]);

  const toggleEnv = (label) => {
    const next = f.envs.includes(label) ? f.envs.filter((x) => x !== label) : [...f.envs, label];
    f.patch({ [PARAMS.env]: next.join(',') });
  };
  const toggleKind = (k) => {
    const next = f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k];
    f.patch({ [PARAMS.kind]: next.join(',') });
  };

  if (events === null && !loading) return null; // endpoint unavailable (e.g. migration not applied) — hide quietly

  const chip = (on) => `rounded px-1.5 py-0.5 border text-[11px] ${on ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-500/10' : 'border-[var(--gray-5)] text-[var(--gray-10)] hover:text-[var(--gray-12)]'}`;

  return (
    <div className="rounded-md border border-[var(--gray-5)] px-3 py-2 space-y-2">
      {/* ── filter bar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs font-medium text-[var(--gray-11)]">Activity log</span>
        {TIME_RANGES.map((r) => (
          <button key={r.key} className={chip(f.range === r.key)}
            onClick={() => f.patch({ [PARAMS.range]: r.key === '1h' ? '' : r.key })}>{r.label}</button>
        ))}
        {f.range === 'custom' && (
          <>
            <input type="datetime-local" value={f.from} onChange={(e) => f.patch({ [PARAMS.from]: e.target.value })}
              className="rounded border border-[var(--gray-5)] bg-transparent px-1 py-0.5 text-[11px]" aria-label="From" />
            <span className="text-[11px] text-[var(--gray-10)]">→</span>
            <input type="datetime-local" value={f.to} onChange={(e) => f.patch({ [PARAMS.to]: e.target.value })}
              className="rounded border border-[var(--gray-5)] bg-transparent px-1 py-0.5 text-[11px]" aria-label="To" />
          </>
        )}
        <span className="mx-1 h-3 w-px bg-[var(--gray-6)]" />
        {KIND_FILTER_GROUPS.map((g) => (
          <button key={g.key} className={chip(f.kinds.length === 0 && f.group === g.key)}
            title={g.kinds ? g.kinds.join(', ') : 'Every event kind'}
            onClick={() => f.patch({ [PARAMS.group]: g.key === 'all' ? '' : g.key, [PARAMS.kind]: '' })}>
            {g.label}
          </button>
        ))}
        <button className={chip(kindPicker || f.kinds.length > 0)} onClick={() => setKindPicker((v) => !v)}
          title="Pick individual event kinds">
          kinds{f.kinds.length > 0 ? ` (${f.kinds.length})` : '…'}
        </button>
        <span className="mx-1 h-3 w-px bg-[var(--gray-6)]" />
        <label className="inline-flex items-center gap-1 rounded border border-[var(--gray-5)] px-1.5 py-0.5">
          <MagnifyingGlassIcon className="size-3 text-[var(--gray-10)]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search detail"
            className="w-40 bg-transparent text-[11px] outline-none" aria-label="Search event detail" />
          {search && <button onClick={() => setSearch('')} className="text-[var(--gray-10)]" aria-label="Clear search"><XMarkIcon className="size-3" /></button>}
        </label>
        <span className="ml-auto flex items-center gap-1.5">
          <label className="inline-flex items-center gap-1 text-[11px] text-[var(--gray-10)]"
            title="Fold consecutive same-kind bursts (visits, logins, service errors) into one expandable row">
            <input type="checkbox" className="size-3" checked={f.collapse}
              onChange={(e) => f.patch({ [PARAMS.collapse]: e.target.checked ? '' : '0' })} />
            group
          </label>
          <Button variant={f.tail ? 'soft' : 'ghost'} size="xs" onClick={() => f.patch({ [PARAMS.tail]: f.tail ? '' : '1' })}
            title={f.tail ? 'Stop following new events' : 'Follow new events as they arrive (pins to the newest row unless you scroll away)'}>
            {f.tail ? <PauseIcon className="size-3.5 mr-1" /> : <PlayIcon className="size-3.5 mr-1" />}
            {f.tail ? 'Tailing' : 'Live tail'}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => { load(); loadSummary(); }} disabled={loading} title="Reload">
            <ArrowPathIcon className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </span>
      </div>

      {kindPicker && (
        <div className="flex items-center gap-1 flex-wrap rounded border border-dashed border-[var(--gray-6)] px-2 py-1.5">
          {ALL_KINDS.map((k) => (
            <button key={k} className={chip(f.kinds.includes(k))} onClick={() => toggleKind(k)}>{kindLabel(k)}</button>
          ))}
          {f.kinds.length > 0 && (
            <button className="ml-1 text-[11px] text-[var(--gray-10)] underline" onClick={() => f.patch({ [PARAMS.kind]: '' })}>clear</button>
          )}
        </div>
      )}

      {(envOptions.length > 0 || f.envs.length > 0) && (
        <div className="flex items-center gap-1 flex-wrap">
          <button className={chip(f.envs.length === 0)} onClick={() => f.patch({ [PARAMS.env]: '' })}>all envs</button>
          {envOptions.map((l) => (
            <button key={l} className={`${chip(f.envs.includes(l))} font-mono`} onClick={() => toggleEnv(l)}>{l}</button>
          ))}
          <button className={chip(f.envs.includes(NO_ENV))} onClick={() => toggleEnv(NO_ENV)}
            title="Events with no environment — the shared Authelia login stream">(no env)</button>
        </div>
      )}

      <SummaryStrip summary={summary} onPickEnv={(l) => f.patch({ [PARAMS.env]: l })} />

      {/* ── log + drill-down ─────────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row gap-2">
        <div className="min-w-0 flex-1">
          {groups.length === 0 ? (
            <div className="px-1 py-3 text-[11px] text-[var(--gray-10)]">
              {loading ? 'Loading…' : 'No events match these filters.'}
            </div>
          ) : (
            <div ref={listRef} onScroll={onScroll} className="max-h-[28rem] overflow-y-auto pr-1">
              {groups.map((g) => (
                <LogRow key={g.key} g={g} now={now ?? Date.now()} selectedId={selected?.id}
                  onSelect={(e) => setSelected((cur) => (cur?.id === e.id ? null : e))}
                  isNew={fresh.has(g.head.id)} />
              ))}
              {hasMore && (
                <div className="pt-1.5">
                  <Button variant="ghost" size="xs" onClick={loadOlder} disabled={older}>
                    {older ? 'Loading…' : `Load older (${PAGE_SIZE} more)`}
                  </Button>
                </div>
              )}
              {!hasMore && (events?.length ?? 0) > 0 && (
                <div className="pt-1.5 text-[10px] text-[var(--gray-9)]">
                  end of the window · {events.length} event{events.length === 1 ? '' : 's'} loaded
                </div>
              )}
            </div>
          )}
        </div>
        {selected && <DetailPanel event={selected} all={events ?? []} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
