/** R2 — recipient-local hour×dow engagement heatmap + best-send-hour callout. */

import { useMemo, useState } from 'react';
import { useGeoRpc } from './useGeoRpc.js';
import type { GeoMetric, LocalTimeRow } from './geo-types.js';
import { DOW_LABELS, bestLocalHour, heatColor, hourLabel, maxOf } from './geo-format.js';
import { ReportFrame, Toggle } from './_shared.js';

type Mode = 'normalised' | 'absolute';

export function LocalTimeHeatmap({ editionId }: { editionId: string }) {
  const [metric, setMetric] = useState<GeoMetric>('click');
  const [mode, setMode] = useState<Mode>('normalised');
  const { env, loading, error, schemaMismatch } = useGeoRpc<LocalTimeRow>(
    'newsletter_local_time_engagement',
    { p_edition_id: editionId, p_metric: metric },
    [editionId, metric],
  );
  const rows = env?.data ?? [];

  const pick = (r: LocalTimeRow) => (mode === 'normalised' ? (r.rate ?? 0) : r.event_count);
  const cellMap = useMemo(() => {
    const m = new Map<string, LocalTimeRow>();
    for (const r of rows) m.set(`${r.dow}-${r.hour}`, r);
    return m;
  }, [rows]);
  const max = useMemo(() => maxOf(rows, pick), [rows, mode]);
  const best = useMemo(() => bestLocalHour(rows), [rows]);

  return (
    <ReportFrame
      title="When they engage (their local time)"
      description="Each cell is opens/clicks at that local hour. Normalised divides by recipients in each timezone so a big region doesn’t dominate."
      loading={loading}
      error={error}
      schemaMismatch={schemaMismatch}
      env={env}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Toggle ariaLabel="Metric" value={metric} onChange={setMetric}
          options={[{ value: 'click', label: 'Clicks' }, { value: 'open', label: 'Opens' }]} />
        <Toggle ariaLabel="Mode" value={mode} onChange={setMode}
          options={[{ value: 'normalised', label: 'Normalised' }, { value: 'absolute', label: 'Absolute' }]} />
        {best && (
          <span className="ml-auto rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700">
            Best local hour: {hourLabel(best.hour)}
          </span>
        )}
      </div>

      {/* heatmap grid */}
      <div className="overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: 2 }}>
          <caption className="sr-only">Engagement by local day-of-week and hour</caption>
          <thead>
            <tr>
              <th className="w-10" />
              {[...Array(24)].map((_, h) => (
                <th key={h} className="text-[10px] font-normal text-gray-400" scope="col">
                  {h % 3 === 0 ? h : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DOW_LABELS.map((label, dow) => (
              <tr key={dow}>
                <th className="pr-1 text-right text-xs font-medium text-gray-500" scope="row">{label}</th>
                {[...Array(24)].map((_, hour) => {
                  const cell = cellMap.get(`${dow}-${hour}`);
                  const v = cell ? pick(cell) : 0;
                  const t = max ? v / max : 0;
                  return (
                    <td key={hour}>
                      <div
                        className="h-5 w-5 rounded-sm"
                        style={{ backgroundColor: v > 0 ? heatColor(t) : '#f3f4f6' }}
                        title={`${label} ${hourLabel(hour)} — ${cell ? (mode === 'normalised' ? (cell.rate ?? 0).toFixed(3) : cell.event_count) : 0}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-400">Columns are hours 0–23 in each recipient’s local timezone.</p>
    </ReportFrame>
  );
}
