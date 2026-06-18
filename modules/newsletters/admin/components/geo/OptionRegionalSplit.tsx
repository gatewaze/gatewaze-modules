/** R4 — per-option regional split for a poll/HotTake block ("where opinion splits"). */

import { useMemo, useState } from 'react';
import { useGeoRpc } from './useGeoRpc.js';
import type { BlockGeoRow, OptionGeoRow } from './geo-types.js';
import { countryName } from './world-geo.js';
import { buildRegionSplits, pct } from './geo-format.js';
import { ReportFrame } from './_shared.js';

const OPTION_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];

/** Picks poll-like blocks (>1 tracked option) from R3 data, then renders R4. */
export function OptionRegionalSplit({ editionId, pollBlockIds }: { editionId: string; pollBlockIds: Array<{ id: string; label: string }> }) {
  const [blockId, setBlockId] = useState(pollBlockIds[0]?.id ?? '');
  const { env, loading, error, schemaMismatch } = useGeoRpc<OptionGeoRow>(
    'newsletter_block_option_geo',
    { p_edition_id: editionId, p_block_id: blockId, p_level: 'country' },
    [editionId, blockId],
  );
  const splits = useMemo(() => buildRegionSplits(env?.data ?? []), [env]);
  const optionColor = useMemo(() => {
    const labels = [...new Set((env?.data ?? []).map((r) => r.option_label))];
    const m = new Map<string, string>();
    labels.forEach((l, i) => m.set(l, OPTION_COLORS[i % OPTION_COLORS.length]));
    return m;
  }, [env]);

  if (!pollBlockIds.length) return null;

  return (
    <ReportFrame
      title="How the vote splits by region"
      description="For a poll block, each region’s option split — ranked by how far it diverges from the overall result."
      loading={loading}
      error={error}
      schemaMismatch={schemaMismatch}
      env={env}
    >
      {pollBlockIds.length > 1 && (
        <div className="mb-3">
          <label className="mr-2 text-sm text-gray-500">Poll block</label>
          <select className="rounded-md border border-gray-200 px-2 py-1 text-sm" value={blockId} onChange={(e) => setBlockId(e.target.value)}>
            {pollBlockIds.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </div>
      )}

      {/* legend */}
      <div className="mb-3 flex flex-wrap gap-3 text-xs">
        {[...optionColor.entries()].map(([label, color]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: color }} />{label}
          </span>
        ))}
      </div>

      <div className="space-y-2">
        {splits.map((s) => (
          <div key={s.region_code} className="flex items-center gap-3">
            <div className="w-32 shrink-0 text-right text-sm text-gray-700">
              {countryName(s.region_code)}
              <span className="ml-1 text-xs text-gray-400">({s.total})</span>
            </div>
            <div className="flex h-6 flex-1 overflow-hidden rounded-md" role="img"
                 aria-label={s.options.map((o) => `${o.label} ${pct(o.share)}`).join(', ')}>
              {s.options.map((o) => (
                <div key={o.label} className="flex items-center justify-center text-[11px] text-white"
                     style={{ width: `${o.share * 100}%`, backgroundColor: optionColor.get(o.label) }}
                     title={`${countryName(s.region_code)} — ${o.label}: ${o.clicks} (${pct(o.share)})`}>
                  {o.share > 0.12 ? pct(o.share, 0) : ''}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </ReportFrame>
  );
}

/** Identify poll-capable blocks from the R3 dataset (heuristic: known poll types). */
export function pollBlocksFrom(rows: BlockGeoRow[]): Array<{ id: string; label: string }> {
  const POLL_TYPES = new Set(['hot_take', 'poll', 'vote', 'survey']);
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (POLL_TYPES.has(r.block_type)) seen.set(r.block_id, r.block_label);
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}
