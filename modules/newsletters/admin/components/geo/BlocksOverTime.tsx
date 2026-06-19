/**
 * Cross-edition block effectiveness (newsletter Stats → Blocks). Shows how each
 * block type performs at generating clicks, edition over edition — a heat matrix
 * (block_type × edition) plus a leaderboard of the best-performing blocks.
 */

import { useMemo, useState } from 'react';
import { useGeoRpc } from './useGeoRpc.js';
import type { BlockEffectivenessRow } from './geo-types.js';
import { heatColor, pct } from './geo-format.js';
import { ReportFrame, Toggle } from './_shared.js';

type Metric = 'ctr' | 'clickers';

export function BlocksOverTime({ editionIds }: { editionIds: string[] }) {
  const [metric, setMetric] = useState<Metric>('ctr');
  const { env, loading, error, schemaMismatch } = useGeoRpc<BlockEffectivenessRow>(
    'newsletter_block_effectiveness',
    { p_edition_ids: editionIds },
    [editionIds.join(',')],
  );
  const rows = env?.data ?? [];

  const { editions, blockTypes, cell, max, totals } = useMemo(() => {
    const edMap = new Map<string, { id: string; date: string | null; title: string }>();
    const btSet = new Set<string>();
    const cellMap = new Map<string, BlockEffectivenessRow>();
    const totalByBt = new Map<string, number>();
    let mx = 0;
    for (const r of rows) {
      edMap.set(r.edition_id, { id: r.edition_id, date: r.edition_date, title: r.edition_title });
      btSet.add(r.block_type);
      cellMap.set(`${r.block_type}|${r.edition_id}`, r);
      totalByBt.set(r.block_type, (totalByBt.get(r.block_type) ?? 0) + r.clickers);
      const v = metric === 'ctr' ? (r.ctr ?? 0) : r.clickers;
      if (v > mx) mx = v;
    }
    const edList = [...edMap.values()].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    const btList = [...btSet].sort((a, b) => (totalByBt.get(b) ?? 0) - (totalByBt.get(a) ?? 0));
    return { editions: edList, blockTypes: btList, cell: cellMap, max: mx, totals: totalByBt };
  }, [rows, metric]);

  const fmt = (r: BlockEffectivenessRow | undefined) =>
    !r ? '' : metric === 'ctr' ? pct(r.ctr) : r.clickers.toLocaleString();
  const edLabel = (e: { date: string | null; title: string }) =>
    e.date ? new Date(e.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : (e.title || '—');

  return (
    <ReportFrame
      title="Block effectiveness over time"
      description="Click-through by block type across editions. Which blocks reliably drive clicks?"
      loading={loading}
      error={error}
      schemaMismatch={schemaMismatch}
      env={env}
    >
      <div className="mb-3">
        <Toggle ariaLabel="Metric" value={metric} onChange={setMetric}
          options={[{ value: 'ctr', label: 'CTR' }, { value: 'clickers', label: 'Clicks' }]} />
      </div>

      {/* leaderboard */}
      <div className="mb-4 flex flex-wrap gap-2">
        {blockTypes.slice(0, 6).map((bt) => (
          <span key={bt} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
            {bt} · {(totals.get(bt) ?? 0).toLocaleString()} clicks
          </span>
        ))}
      </div>

      {/* heat matrix: block_type × edition */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Block {metric === 'ctr' ? 'CTR' : 'clicks'} by edition</caption>
          <thead>
            <tr className="border-b border-gray-200">
              <th className="px-2 py-1 text-left font-medium text-gray-500" scope="col">Block</th>
              {editions.map((e) => (
                <th key={e.id} className="px-2 py-1 text-right font-medium text-gray-500 whitespace-nowrap" scope="col">{edLabel(e)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {blockTypes.map((bt) => (
              <tr key={bt} className="border-b border-gray-100">
                <th className="px-2 py-1 text-left font-normal text-gray-900" scope="row">{bt}</th>
                {editions.map((e) => {
                  const r = cell.get(`${bt}|${e.id}`);
                  const v = r ? (metric === 'ctr' ? (r.ctr ?? 0) : r.clickers) : 0;
                  const t = max ? v / max : 0;
                  return (
                    <td key={e.id} className="px-2 py-1 text-right tabular-nums"
                        style={{ backgroundColor: v > 0 ? heatColor(t) : undefined }}
                        title={r ? `${bt} — ${edLabel(e)}: ${r.clickers} clicks / ${r.delivered} delivered (CTR ${pct(r.ctr)})` : ''}>
                      {fmt(r)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportFrame>
  );
}
