// @ts-nocheck
/**
 * Reusable run list for the Overview dashboard (SPEC.md §14.1): active runs, recently completed
 * runs, and the two human-gate sections (awaiting spec approval, architecture review). Each row shows
 * status, elapsed time, and cost — the fields the Runs board already renders per run — and, when
 * `onOpenRun` is supplied, opens that run's detail pane (the Runs board already has the Approve
 * button for gated runs, so this list stays read-only and link-through rather than duplicating that
 * write action here).
 */
import React from 'react';
import { Badge } from '@/components/ui';
import { STATUS_COLOR, STATUS_LABELS, fmtCost, formatDuration } from './overview-filters';
import { ProjectAvatar } from './ProjectAvatar';

export interface RunListRow {
  id: string;
  status: string;
  kind?: string;
  repo_owner?: string;
  repo_name?: string;
  issue_number?: number | null;
  title?: string | null;
  cost_usd?: number | null;
  started_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  project?: { name?: string; avatar_emoji?: string } | null;
}

export const runLabel = (r: RunListRow): string =>
  r.kind === 'interactive'
    ? `Interactive session${r.project?.name ? ` · ${r.project.name}` : ''}`
    : `${r.repo_owner}/${r.repo_name} #${r.issue_number}`;

export default function RunListSection({ title, rows, emptyLabel, onOpenRun, durationEnd }: {
  title: string;
  rows: RunListRow[];
  emptyLabel: string;
  onOpenRun?: (id: string) => void;
  // 'now' (default, via formatDuration's own default) for in-flight runs, whose duration ticks up on
  // each refresh; 'updated_at' for completed runs whose clock has stopped.
  durationEnd?: 'updated_at';
}) {
  return (
    <section className="rounded-lg border border-[var(--gray-5)] p-4 space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">{title}</div>
      {rows.length === 0 ? (
        <div className="text-sm text-[var(--gray-10)]">{emptyLabel}</div>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => {
            const start = r.started_at ?? r.created_at;
            const dur = durationEnd === 'updated_at' ? formatDuration(start, r.updated_at) : formatDuration(start);
            const body = (
              <>
                <div className="flex items-center gap-2 min-w-0">
                  <ProjectAvatar emoji={r.project?.avatar_emoji} className="size-4 shrink-0" />
                  <span className="truncate text-sm text-[var(--gray-12)]">{r.title || runLabel(r)}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {dur && <span className="text-xs tabular-nums text-[var(--gray-10)]">{dur}</span>}
                  {fmtCost(r.cost_usd) && <span className="text-xs font-mono text-[var(--gray-10)]">{fmtCost(r.cost_usd)}</span>}
                  <Badge color={STATUS_COLOR[r.status] ?? 'gray'} size="1">{STATUS_LABELS[r.status] ?? r.status}</Badge>
                </div>
              </>
            );
            return onOpenRun ? (
              <button
                key={r.id}
                type="button"
                onClick={() => onOpenRun(r.id)}
                className="w-full flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--gray-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {body}
              </button>
            ) : (
              <div key={r.id} className="flex items-center justify-between gap-3 px-2 py-1.5">{body}</div>
            );
          })}
        </div>
      )}
    </section>
  );
}
