/**
 * Overall poll/vote results (newsletter Stats → Blocks). For each poll / hot_take
 * block, the whole-audience vote split across its real option buttons — no region
 * breakdown. One stacked bar per poll, most recent edition first.
 */

import { useMemo } from 'react';
import { useGeoRpc } from './useGeoRpc.js';
import type { PollResultRow } from './geo-types.js';
import { pct } from './geo-format.js';
import { ReportFrame } from './_shared.js';

const OPTION_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];

interface Poll {
  block_id: string;
  edition_title: string;
  edition_date: string | null;
  total: number;
  options: Array<{ index: number; label: string; clicks: number; share: number }>;
}

export function PollResults({ editionIds }: { editionIds: string[] }) {
  const { env, loading, error, schemaMismatch } = useGeoRpc<PollResultRow>(
    'newsletter_poll_results',
    { p_edition_ids: editionIds },
    [editionIds.join(',')],
  );

  const polls = useMemo<Poll[]>(() => {
    const byBlock = new Map<string, PollResultRow[]>();
    for (const r of env?.data ?? []) {
      const arr = byBlock.get(r.block_id) ?? [];
      arr.push(r);
      byBlock.set(r.block_id, arr);
    }
    const out: Poll[] = [];
    for (const [block_id, rs] of byBlock) {
      const total = rs.reduce((a, b) => a + b.clicks, 0);
      const options = rs
        .slice()
        .sort((a, b) => a.option_index - b.option_index)
        .map((r) => ({ index: r.option_index, label: r.option_label, clicks: r.clicks, share: total ? r.clicks / total : 0 }));
      out.push({ block_id, edition_title: rs[0].edition_title, edition_date: rs[0].edition_date, total, options });
    }
    return out.sort((a, b) => (b.edition_date ?? '').localeCompare(a.edition_date ?? ''));
  }, [env]);

  return (
    <ReportFrame
      title="Poll results"
      description="Overall vote split for each poll / hot-take, across the whole audience."
      loading={loading}
      error={error}
      schemaMismatch={schemaMismatch}
      env={env}
    >
      <div className="space-y-5">
        {polls.map((p) => {
          const winner = p.options.reduce((a, b) => (b.clicks > a.clicks ? b : a), p.options[0]);
          return (
            <div key={p.block_id}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-sm font-medium text-gray-900">
                  {p.edition_date ? new Date(p.edition_date).toLocaleDateString() + ' — ' : ''}{p.edition_title || 'Untitled'}
                </span>
                <span className="text-xs text-gray-400">{p.total.toLocaleString()} votes</span>
              </div>
              <div className="flex h-7 overflow-hidden rounded-md" role="img"
                   aria-label={p.options.map((o) => `${o.label} ${pct(o.share)}`).join(', ')}>
                {p.options.map((o, i) => (
                  <div key={o.index} className="flex items-center justify-center text-xs font-medium text-white"
                       style={{ width: `${o.share * 100}%`, backgroundColor: OPTION_COLORS[i % OPTION_COLORS.length] }}
                       title={`${o.label}: ${o.clicks.toLocaleString()} (${pct(o.share)})`}>
                    {o.share > 0.1 ? `${o.label} ${pct(o.share, 0)}` : ''}
                  </div>
                ))}
              </div>
              <div className="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
                {p.options.map((o, i) => (
                  <span key={o.index} className="inline-flex items-center gap-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: OPTION_COLORS[i % OPTION_COLORS.length] }} />
                    {o.label} · {o.clicks.toLocaleString()} ({pct(o.share, 0)})
                  </span>
                ))}
                {winner && <span className="text-gray-400">· winner: {winner.label}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </ReportFrame>
  );
}
