/** R3 — block × region click matrix (which blocks each region clicks). */

import { useMemo } from 'react';
import { useGeoRpc } from './useGeoRpc.js';
import type { BlockGeoRow } from './geo-types.js';
import { countryName } from './world-geo.js';
import { heatColor } from './geo-format.js';
import { ReportFrame } from './_shared.js';

export function BlockRegionMatrix({ editionId }: { editionId: string }) {
  const { env, loading, error, schemaMismatch } = useGeoRpc<BlockGeoRow>(
    'newsletter_block_geo',
    { p_edition_id: editionId, p_level: 'country' },
    [editionId],
  );
  const rows = env?.data ?? [];

  const { blocks, regions, cell, max, blockTotals } = useMemo(() => {
    const blockMap = new Map<string, string>();   // block_id -> label
    const regionTotals = new Map<string, number>();
    const cellMap = new Map<string, number>();     // `${block_id}|${region}` -> clicks
    const blkTotals = new Map<string, number>();
    let mx = 0;
    for (const r of rows) {
      blockMap.set(r.block_id, r.block_label);
      regionTotals.set(r.region_code, (regionTotals.get(r.region_code) ?? 0) + r.clicks);
      cellMap.set(`${r.block_id}|${r.region_code}`, r.clicks);
      blkTotals.set(r.block_id, (blkTotals.get(r.block_id) ?? 0) + r.clicks);
      if (r.clicks > mx) mx = r.clicks;
    }
    const regionList = [...regionTotals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const blockList = [...blockMap.entries()].sort((a, b) => (blkTotals.get(b[0]) ?? 0) - (blkTotals.get(a[0]) ?? 0));
    return { blocks: blockList, regions: regionList, cell: cellMap, max: mx, blockTotals: blkTotals };
  }, [rows]);

  return (
    <ReportFrame
      title="Which blocks each region clicks"
      description="Click counts by block and region (by open location). Darker = more clicks."
      loading={loading}
      error={error}
      schemaMismatch={schemaMismatch}
      env={env}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Clicks by block and region</caption>
          <thead>
            <tr className="border-b border-gray-200">
              <th className="px-2 py-1 text-left font-medium text-gray-500" scope="col">Block</th>
              {regions.map((c) => (
                <th key={c} className="px-2 py-1 text-right font-medium text-gray-500" scope="col">
                  {c === '__other__' ? 'Other' : c}
                </th>
              ))}
              <th className="px-2 py-1 text-right font-medium text-gray-500" scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map(([blockId, label]) => (
              <tr key={blockId} className="border-b border-gray-100">
                <th className="px-2 py-1 text-left font-normal text-gray-900" scope="row">{label}</th>
                {regions.map((c) => {
                  const v = cell.get(`${blockId}|${c}`) ?? 0;
                  const t = max ? v / max : 0;
                  return (
                    <td key={c} className="px-2 py-1 text-right tabular-nums"
                        style={{ backgroundColor: v > 0 ? heatColor(t) : undefined }}
                        title={`${label} — ${countryName(c)}: ${v} clicks`}>
                      {v || ''}
                    </td>
                  );
                })}
                <td className="px-2 py-1 text-right font-medium tabular-nums">{blockTotals.get(blockId) ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportFrame>
  );
}
