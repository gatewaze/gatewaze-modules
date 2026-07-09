/**
 * Overview tab — Umami-style headline stats, traffic chart, and dimension
 * breakdowns. All styling uses the admin's Radix theme tokens.
 */
import { useEffect, useMemo, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { getJson, rangeParams, RANGES, formatDuration, countryLabel, PANEL, MUTED, STRONG, type RangeKey } from './shared';

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

const BREAKDOWN_PANELS: Array<{ type: string; title: string; empty: string }> = [
  { type: 'path', title: 'Pages', empty: 'No pageviews yet' },
  { type: 'referrer', title: 'Referrers', empty: 'No referrers yet' },
  { type: 'browser', title: 'Browsers', empty: 'No visits yet' },
  { type: 'os', title: 'Operating systems', empty: 'No visits yet' },
  { type: 'device', title: 'Devices', empty: 'No visits yet' },
  { type: 'country', title: 'Countries', empty: 'No visits yet' },
  { type: 'title', title: 'Page titles', empty: 'No pageviews yet' },
  { type: 'event', title: 'Events', empty: 'No custom events yet' },
];

export default function OverviewTab({ propertyId, rangeKey }: { propertyId: string; rangeKey: RangeKey }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [series, setSeries] = useState<SeriesBucket[]>([]);
  const [breakdowns, setBreakdowns] = useState<Record<string, BreakdownRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = rangeParams(rangeKey);
    const { bucket } = RANGES[rangeKey];
    Promise.all([
      getJson<{ overview: Overview }>(`/api/modules/analytics/properties/${propertyId}/overview?${qs}`),
      getJson<{ pageviews: SeriesBucket[] }>(`/api/modules/analytics/properties/${propertyId}/pageviews?${qs}&bucket=${bucket}`),
      Promise.all(
        BREAKDOWN_PANELS.map((p) =>
          getJson<{ rows: BreakdownRow[] }>(`/api/modules/analytics/properties/${propertyId}/breakdown?${qs}&type=${p.type}&limit=8`)
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
  }, [propertyId, rangeKey]);

  // Live active-now refresh.
  useEffect(() => {
    const t = setInterval(() => {
      getJson<{ overview: Overview }>(`/api/modules/analytics/properties/${propertyId}/overview?${rangeParams(rangeKey)}`)
        .then((b) => setOverview((prev) => (prev ? { ...prev, active_now: b.overview.active_now } : b.overview)))
        .catch(() => undefined);
    }, 30_000);
    return () => clearInterval(t);
  }, [propertyId, rangeKey]);

  const chartOptions = useMemo<ApexOptions>(() => ({
    chart: { type: 'area', toolbar: { show: false }, zoom: { enabled: false }, fontFamily: 'inherit', background: 'transparent' },
    theme: { mode: undefined },
    stroke: { curve: 'smooth', width: 2 },
    dataLabels: { enabled: false },
    fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.05 } },
    xaxis: {
      categories: series.map((b) => b.bucket),
      labels: {
        rotate: 0,
        style: { colors: 'var(--gray-10)' },
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
    yaxis: { labels: { formatter: (v: number) => `${Math.round(v)}`, style: { colors: 'var(--gray-10)' } } },
    legend: { position: 'top', horizontalAlign: 'right', labels: { colors: 'var(--gray-11)' } },
    grid: { strokeDashArray: 4, borderColor: 'var(--gray-5)' },
    colors: ['var(--accent-9)', '#22c55e'],
  }), [series, rangeKey]);

  const chartSeries = useMemo(() => ([
    { name: 'Views', data: series.map((b) => b.pageviews) },
    { name: 'Visitors', data: series.map((b) => b.unique_visitors) },
  ]), [series]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-[var(--red-6)] bg-[var(--red-2)] text-[var(--red-11)] px-4 py-3 text-sm">
          Failed to load analytics: {error}
        </div>
      )}

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
        <div className={PANEL}>
          <div className={`text-xs uppercase tracking-wide ${MUTED} flex items-center gap-1.5`}>
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            Active now
          </div>
          <div className={`text-2xl font-bold mt-1 ${STRONG}`}>{overview?.active_now ?? '—'}</div>
        </div>
      </div>

      <div className={PANEL}>
        {series.length === 0 && !loading ? (
          <div className={`h-64 flex items-center justify-center ${MUTED} text-sm`}>No traffic in this range yet.</div>
        ) : (
          <ReactApexChart options={chartOptions} series={chartSeries} type="area" height={280} />
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {BREAKDOWN_PANELS.map((p) => (
          <BreakdownPanel
            key={p.type}
            title={p.title}
            emptyText={p.empty}
            rows={breakdowns[p.type] ?? []}
            renderLabel={p.type === 'country' ? (l: string) => countryLabel(l) : undefined}
            mono={p.type === 'path' || p.type === 'referrer'}
          />
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, prev, format, invertDelta, loading }: {
  label: string;
  value?: number;
  prev?: number;
  format?: (v: number) => string;
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
    <div className={PANEL}>
      <div className={`text-xs uppercase tracking-wide ${MUTED}`}>{label}</div>
      <div className={`text-2xl font-bold mt-1 ${STRONG}`}>
        {loading && value === undefined ? '…' : value !== undefined ? fmt(value) : '—'}
      </div>
      {delta !== null && (
        <div className={`text-xs mt-0.5 font-medium ${good ? 'text-[var(--green-11)]' : 'text-[var(--red-11)]'}`}>
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
    <div className={PANEL}>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className={`font-semibold ${STRONG}`}>{title}</h3>
        {total > 0 && <span className={`text-xs ${MUTED}`}>{total.toLocaleString()} total</span>}
      </div>
      {rows.length === 0 ? (
        <p className={`text-sm ${MUTED} py-4`}>{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.label} className="relative flex items-center justify-between text-sm py-1.5 px-2 rounded">
              <span
                className="absolute inset-y-0 left-0 rounded bg-[var(--accent-4)]"
                style={{ width: `${max > 0 ? (r.count / max) * 100 : 0}%`, opacity: 0.5 }}
              />
              <span className={`relative truncate pr-3 ${STRONG} ${mono ? 'font-mono text-xs' : ''}`}>
                {(renderLabel ? renderLabel(r.label) : r.label) || '(none)'}
              </span>
              <span className={`relative font-semibold tabular-nums ${STRONG}`}>{r.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
