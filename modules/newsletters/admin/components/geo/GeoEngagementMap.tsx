/** R1 — geographic engagement: SVG bubble world map + sortable data table. */

import { useMemo, useState } from 'react';
import { useGeoRpc } from './useGeoRpc.js';
import type { GeoEngagementRow, GeoMetric } from './geo-types.js';
import { project, centroid, countryName } from './world-geo.js';
import { heatColor, maxOf, pct } from './geo-format.js';
import { ReportFrame, Toggle } from './_shared.js';

const W = 720;
const H = 360;

export function GeoEngagementMap({ editionId }: { editionId: string }) {
  const [metric, setMetric] = useState<GeoMetric>('click');
  const { env, loading, error, schemaMismatch } = useGeoRpc<GeoEngagementRow>(
    'newsletter_geo_engagement',
    { p_edition_id: editionId, p_metric: metric, p_level: 'country' },
    [editionId, metric],
  );
  const rows = env?.data ?? [];

  const maxRate = useMemo(() => maxOf(rows, (r) => r.rate_profile ?? 0), [rows]);
  const bubbles = useMemo(
    () =>
      rows
        .map((r) => {
          const c = centroid(r.region_code);
          if (!c) return null;
          const p = project(c.lng, c.lat, W, H);
          const rate = r.rate_profile ?? 0;
          return { row: r, x: p.x, y: p.y, t: maxRate ? rate / maxRate : 0 };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .sort((a, b) => a.t - b.t),
    [rows, maxRate],
  );

  const metricLabel = metric === 'click' ? 'CTR' : 'Open rate';

  return (
    <ReportFrame
      title="Where it’s read & clicked"
      description="Engagement rate by recipients’ profile region; raw counts are by open location (IP). The two are never blended."
      loading={loading}
      error={error}
      schemaMismatch={schemaMismatch}
      env={env}
    >
      <div className="mb-3">
        <Toggle
          ariaLabel="Metric"
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'click', label: 'Clicks / CTR' },
            { value: 'open', label: 'Opens / open rate' },
          ]}
        />
      </div>

      {/* SVG bubble map (enhancement) */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-gray-100 bg-[#f0f5fb]" role="img"
           aria-label={`World map of ${metricLabel} by region`}>
        {/* faint graticule */}
        {[...Array(11)].map((_, i) => (
          <line key={`v${i}`} x1={(i / 11) * W} y1={0} x2={(i / 11) * W} y2={H} stroke="#dbe6f3" strokeWidth={1} />
        ))}
        {[...Array(6)].map((_, i) => (
          <line key={`h${i}`} x1={0} y1={(i / 6) * H} x2={W} y2={(i / 6) * H} stroke="#dbe6f3" strokeWidth={1} />
        ))}
        {bubbles.map((b) => {
          const radius = 6 + b.t * 22;
          return (
            <g key={b.row.region_code}>
              <circle cx={b.x} cy={b.y} r={radius} fill={heatColor(b.t)} fillOpacity={0.75} stroke="#fff" strokeWidth={1}>
                <title>
                  {countryName(b.row.region_code)} — {metricLabel} {pct(b.row.rate_profile)} ({b.row.engaged_profile}/{b.row.delivered_profile}); {b.row.count_ip} {metric}s by location
                </title>
              </circle>
            </g>
          );
        })}
      </svg>

      {/* Sortable data table — the accessible source of truth (spec §9) */}
      <GeoTable rows={rows} metric={metric} />
    </ReportFrame>
  );
}

function GeoTable({ rows, metric }: { rows: GeoEngagementRow[]; metric: GeoMetric }) {
  type Key = 'region' | 'rate' | 'engaged' | 'delivered' | 'count_ip';
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'rate', dir: -1 });
  const sorted = useMemo(() => {
    const val = (r: GeoEngagementRow): number | string =>
      sort.key === 'region' ? countryName(r.region_code)
      : sort.key === 'rate' ? (r.rate_profile ?? -1)
      : sort.key === 'engaged' ? r.engaged_profile
      : sort.key === 'delivered' ? r.delivered_profile
      : r.count_ip;
    return [...rows].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av < bv) return -sort.dir;
      if (av > bv) return sort.dir;
      return 0;
    });
  }, [rows, sort]);
  const head = (key: Key, label: string, align = 'right') => (
    <th
      className={`px-2 py-1 ${align === 'right' ? 'text-right' : 'text-left'} cursor-pointer select-none font-medium text-gray-500 hover:text-gray-700`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      scope="col"
    >
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Engagement by region</caption>
        <thead>
          <tr className="border-b border-gray-200">
            {head('region', 'Region', 'left')}
            {head('rate', metric === 'click' ? 'CTR' : 'Open rate')}
            {head('engaged', 'Engaged')}
            {head('delivered', 'Delivered')}
            {head('count_ip', 'By location (IP)')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.region_code} className="border-b border-gray-100">
              <td className="px-2 py-1 text-left text-gray-900">{countryName(r.region_code)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{pct(r.rate_profile)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{r.engaged_profile.toLocaleString()}</td>
              <td className="px-2 py-1 text-right tabular-nums">{r.delivered_profile.toLocaleString()}</td>
              <td className="px-2 py-1 text-right tabular-nums text-gray-500">{r.count_ip.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
