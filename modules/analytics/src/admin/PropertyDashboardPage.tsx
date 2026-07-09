/**
 * Per-property analytics dashboard — Umami-grade overview per spec §12.2.
 *
 * Headline stat cards (views / visits / visitors / bounce rate / avg
 * visit time) with previous-period deltas + live active-now, a
 * views-vs-visitors area chart, and Umami-style dimension breakdowns
 * (pages, referrers, browsers, OS, devices, countries, events) — all
 * read through the module's JWT-gated /api/modules/analytics surface,
 * which proxies the cluster-internal Umami.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Button, WorkspaceLayout } from '@/components/ui';
import { authedFetch } from './authed-fetch';

const API = () => import.meta.env.VITE_API_URL ?? '';

// ---------------------------------------------------------------------------
// Types (mirror the module's route payloads)
// ---------------------------------------------------------------------------

interface Overview {
  pageviews: number;
  visitors: number;
  visits: number;
  bounce_rate: number;
  avg_visit_seconds: number;
  active_now: number;
  comparison: { pageviews: number; visitors: number; visits: number; bounce_rate: number; avg_visit_seconds: number };
}

interface SeriesBucket { bucket: string; pageviews: number; unique_visitors: number }
interface BreakdownRow { label: string; count: number }

type RangeKey = '24h' | '7d' | '30d' | '90d';
const RANGES: Record<RangeKey, { label: string; hours: number; bucket: 'hour' | 'day' }> = {
  '24h': { label: '24 hours', hours: 24, bucket: 'hour' },
  '7d': { label: '7 days', hours: 7 * 24, bucket: 'day' },
  '30d': { label: '30 days', hours: 30 * 24, bucket: 'day' },
  '90d': { label: '90 days', hours: 90 * 24, bucket: 'day' },
};

const BREAKDOWN_PANELS: Array<{ type: string; title: string; empty: string }> = [
  { type: 'path', title: 'Pages', empty: 'No pageviews yet' },
  { type: 'referrer', title: 'Referrers', empty: 'No referrers yet' },
  { type: 'browser', title: 'Browsers', empty: 'No visits yet' },
  { type: 'os', title: 'Operating systems', empty: 'No visits yet' },
  { type: 'device', title: 'Devices', empty: 'No visits yet' },
  { type: 'country', title: 'Countries', empty: 'No visits yet' },
  { type: 'event', title: 'Events', empty: 'No custom events yet' },
];

// ---------------------------------------------------------------------------

export default function PropertyDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [rangeKey, setRangeKey] = useState<RangeKey>('7d');
  const [propertyName, setPropertyName] = useState<string>('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [series, setSeries] = useState<SeriesBucket[]>([]);
  const [breakdowns, setBreakdowns] = useState<Record<string, BreakdownRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const rangeParams = useCallback(() => {
    const { hours } = RANGES[rangeKey];
    return new URLSearchParams({
      from: new Date(Date.now() - hours * 3600_000).toISOString(),
      to: new Date().toISOString(),
    });
  }, [rangeKey]);

  const getJson = useCallback(async <T,>(path: string): Promise<T> => {
    const r = await authedFetch(`${API()}${path}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<T>;
  }, []);

  // Property name for the breadcrumb (once).
  useEffect(() => {
    if (!id) return;
    getJson<{ property: { name: string } }>(`/api/modules/analytics/properties/${id}`)
      .then((b) => setPropertyName(b.property?.name ?? ''))
      .catch(() => undefined);
  }, [id, getJson]);

  // Overview + chart + breakdowns per range.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = rangeParams();
    const { bucket } = RANGES[rangeKey];
    Promise.all([
      getJson<{ overview: Overview }>(`/api/modules/analytics/properties/${id}/overview?${qs}`),
      getJson<{ pageviews: SeriesBucket[] }>(`/api/modules/analytics/properties/${id}/pageviews?${qs}&bucket=${bucket}`),
      Promise.all(
        BREAKDOWN_PANELS.map((p) =>
          getJson<{ rows: BreakdownRow[] }>(`/api/modules/analytics/properties/${id}/breakdown?${qs}&type=${p.type}&limit=8`)
            .then((b) => [p.type, b.rows] as const)
            .catch(() => [p.type, []] as const),
        ),
      ),
    ])
      .then(([o, pv, bds]) => {
        if (cancelled) return;
        setOverview(o.overview);
        setSeries(pv.pageviews ?? []);
        setBreakdowns(Object.fromEntries(bds));
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, rangeKey, rangeParams, getJson]);

  // Live active-now — repolls the overview (server-side cache keeps this cheap).
  useEffect(() => {
    if (!id) return;
    const tick = () =>
      getJson<{ overview: Overview }>(`/api/modules/analytics/properties/${id}/overview?${rangeParams()}`)
        .then((b) => setOverview((prev) => (prev ? { ...prev, active_now: b.overview.active_now } : b.overview)))
        .catch(() => undefined);
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [id, rangeParams, getJson]);

  const chartOptions = useMemo<ApexOptions>(() => ({
    chart: { type: 'area', toolbar: { show: false }, zoom: { enabled: false }, fontFamily: 'inherit' },
    stroke: { curve: 'smooth', width: 2 },
    dataLabels: { enabled: false },
    fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.05 } },
    xaxis: {
      categories: series.map((b) => b.bucket),
      labels: {
        rotate: 0,
        formatter: (v: string) => {
          const d = new Date(v);
          if (Number.isNaN(d.getTime())) return v;
          return RANGES[rangeKey].bucket === 'hour'
            ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        },
      },
      tickAmount: Math.min(series.length, 12),
      tooltip: { enabled: false },
    },
    yaxis: { labels: { formatter: (v: number) => `${Math.round(v)}` } },
    legend: { position: 'top', horizontalAlign: 'right' },
    grid: { strokeDashArray: 4 },
    colors: ['#6366f1', '#22c55e'],
  }), [series, rangeKey]);

  const chartSeries = useMemo(() => ([
    { name: 'Views', data: series.map((b) => b.pageviews) },
    { name: 'Visitors', data: series.map((b) => b.unique_visitors) },
  ]), [series]);

  if (!id) return <div className="p-8">Missing property id</div>;

  return (
    <WorkspaceLayout
      title="Analytics"
      breadcrumbs={[{ label: 'Analytics', to: '/analytics' }, { label: propertyName || 'Property' }]}
      onBreadcrumbNavigate={(to: string) => navigate(to)}
      actions={
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-white/25">
            {(Object.keys(RANGES) as RangeKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setRangeKey(k)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  rangeKey === k ? 'bg-white/25 font-semibold' : 'hover:bg-white/10'
                }`}
              >
                {RANGES[k].label}
              </button>
            ))}
          </div>
          <Button variant="secondary" onClick={() => navigate(`/analytics/properties/${id}/settings`)}>
            Settings
          </Button>
        </div>
      }
    >
      <div className="px-6 py-6 max-w-7xl mx-auto space-y-6">
        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 text-red-800 px-4 py-3 text-sm">
            Failed to load analytics: {error}
          </div>
        )}

        {/* Headline stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Views" value={overview?.pageviews} prev={overview?.comparison.pageviews} loading={loading} />
          <StatCard label="Visits" value={overview?.visits} prev={overview?.comparison.visits} loading={loading} />
          <StatCard label="Visitors" value={overview?.visitors} prev={overview?.comparison.visitors} loading={loading} />
          <StatCard
            label="Bounce rate"
            value={overview ? Math.round(overview.bounce_rate * 100) : undefined}
            prev={overview ? Math.round(overview.comparison.bounce_rate * 100) : undefined}
            format={(v) => `${v}%`}
            invertDelta
            loading={loading}
          />
          <StatCard
            label="Avg visit time"
            value={overview ? Math.round(overview.avg_visit_seconds) : undefined}
            prev={overview ? Math.round(overview.comparison.avg_visit_seconds) : undefined}
            format={formatDuration}
            loading={loading}
          />
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
            <div className="text-xs uppercase tracking-wide text-neutral-500 flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              Active now
            </div>
            <div className="text-2xl font-bold mt-1">{overview?.active_now ?? '—'}</div>
          </div>
        </div>

        {/* Traffic chart */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
          {series.length === 0 && !loading ? (
            <div className="h-64 flex items-center justify-center text-neutral-500 text-sm">
              No traffic in this range yet.
            </div>
          ) : (
            <ReactApexChart options={chartOptions} series={chartSeries} type="area" height={280} />
          )}
        </div>

        {/* Breakdown panels */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {BREAKDOWN_PANELS.map((p) => (
            <BreakdownPanel
              key={p.type}
              title={p.title}
              emptyText={p.empty}
              rows={breakdowns[p.type] ?? []}
              renderLabel={p.type === 'country' ? countryLabel : undefined}
              mono={p.type === 'path' || p.type === 'referrer'}
            />
          ))}
        </div>
      </div>
    </WorkspaceLayout>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function StatCard({ label, value, prev, format, invertDelta, loading }: {
  label: string;
  value?: number;
  prev?: number;
  format?: (v: number) => string;
  /** For metrics where up is bad (bounce rate). */
  invertDelta?: boolean;
  loading: boolean;
}) {
  const fmt = format ?? ((v: number) => v.toLocaleString());
  let delta: number | null = null;
  if (value !== undefined && prev !== undefined && prev > 0) {
    delta = Math.round(((value - prev) / prev) * 100);
  }
  const good = delta !== null && (invertDelta ? delta <= 0 : delta >= 0);
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="text-2xl font-bold mt-1">
        {loading && value === undefined ? '…' : value !== undefined ? fmt(value) : '—'}
      </div>
      {delta !== null && (
        <div className={`text-xs mt-0.5 font-medium ${good ? 'text-emerald-600' : 'text-red-500'}`}>
          {delta > 0 ? '+' : ''}{delta}% vs previous period
        </div>
      )}
    </div>
  );
}

function BreakdownPanel({ title, rows, emptyText, renderLabel, mono }: {
  title: string;
  rows: BreakdownRow[];
  emptyText: string;
  renderLabel?: (label: string) => string;
  mono?: boolean;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-semibold">{title}</h3>
        {total > 0 && <span className="text-xs text-neutral-500">{total.toLocaleString()} total</span>}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500 py-4">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.label} className="relative flex items-center justify-between text-sm py-1.5 px-2 rounded">
              {/* Umami-style proportional bar behind the row */}
              <span
                className="absolute inset-y-0 left-0 rounded bg-indigo-500/10"
                style={{ width: `${max > 0 ? (r.count / max) * 100 : 0}%` }}
              />
              <span className={`relative truncate pr-3 ${mono ? 'font-mono text-xs' : ''}`}>
                {(renderLabel ? renderLabel(r.label) : r.label) || '(none)'}
              </span>
              <span className="relative font-semibold tabular-nums">{r.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function countryLabel(code: string): string {
  if (!code || code === '(none)') return '(unknown)';
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'region' }).of(code.toUpperCase());
    const flag = code.length === 2
      ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)))
      : '';
    return `${flag} ${name ?? code}`.trim();
  } catch {
    return code;
  }
}
