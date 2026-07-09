/**
 * Retention tab — cohort retention curve (Umami's retention feature,
 * surfaced through the module's aggregated endpoint).
 */
import { useEffect, useMemo, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { getJson, rangeParams, PANEL, MUTED, STRONG, type RangeKey } from './shared';

interface RetentionPoint { day: number; retention_rate: number }

export default function RetentionTab({ propertyId, rangeKey }: { propertyId: string; rangeKey: RangeKey }) {
  const [points, setPoints] = useState<RetentionPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<{ curve: RetentionPoint[] } | { retention: RetentionPoint[] } | Record<string, RetentionPoint[]>>(
      `/api/modules/analytics/properties/${propertyId}/retention-curve?${rangeParams(rangeKey)}&horizonDays=30`,
    )
      .then((b) => {
        if (cancelled) return;
        const arr = (Object.values(b).find(Array.isArray) as RetentionPoint[] | undefined) ?? [];
        setPoints(arr);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [propertyId, rangeKey]);

  const options = useMemo<ApexOptions>(() => ({
    chart: { type: 'line', toolbar: { show: false }, zoom: { enabled: false }, fontFamily: 'inherit', background: 'transparent' },
    stroke: { curve: 'smooth', width: 3 },
    dataLabels: { enabled: false },
    xaxis: {
      categories: points.map((p) => `Day ${p.day}`),
      labels: { style: { colors: 'var(--gray-10)' } },
      tickAmount: Math.min(points.length, 15),
    },
    yaxis: {
      max: 100,
      min: 0,
      labels: { formatter: (v: number) => `${Math.round(v)}%`, style: { colors: 'var(--gray-10)' } },
    },
    grid: { strokeDashArray: 4, borderColor: 'var(--gray-5)' },
    colors: ['var(--accent-9)'],
    tooltip: { y: { formatter: (v: number) => `${v.toFixed(1)}%` } },
  }), [points]);

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-[var(--red-6)] bg-[var(--red-2)] text-[var(--red-11)] px-4 py-3 text-sm">
          Failed to load retention: {error}
        </div>
      )}
      <div className={PANEL}>
        <div className="mb-1">
          <h3 className={`font-semibold ${STRONG}`}>Visitor retention</h3>
          <p className={`text-xs ${MUTED}`}>
            Of visitors first seen in this range, the share that returned N days later (30-day horizon).
          </p>
        </div>
        {loading ? (
          <p className={`text-sm ${MUTED} py-8`}>Loading retention…</p>
        ) : points.length === 0 ? (
          <p className={`text-sm ${MUTED} py-8`}>
            Not enough data yet — retention needs returning visitors across multiple days.
          </p>
        ) : (
          <ReactApexChart
            options={options}
            series={[{ name: 'Retention', data: points.map((p) => +(p.retention_rate * 100).toFixed(1)) }]}
            type="line"
            height={300}
          />
        )}
      </div>
    </div>
  );
}
