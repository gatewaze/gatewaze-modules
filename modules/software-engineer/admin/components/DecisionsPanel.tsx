// @ts-nocheck
/**
 * "Decisions needed" panel (issue #49) — one place on the Overview dashboard to see every run
 * parked waiting on a human, in plain language, with a deep link to act. Replaces the two separate
 * "Awaiting spec approval" / "Architecture review" RunListSections (which only covered two of the
 * six DecisionKinds and left the rest of `blocked` an undifferentiated bucket the operator had to
 * click into individually to understand).
 *
 * Fetches GET /overview/decisions on the SAME refresh cadence as the rest of Overview (Realtime on
 * se_runs + the visibility-poll backstop already wired in OverviewView) — no new polling loop here.
 * Renders nothing when there is nothing to decide, exactly like PendingApprovals.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fmtCost, formatDuration } from './overview-filters';
import { ProjectAvatar } from './ProjectAvatar';
import { runLabel } from './RunListSection';
import { KIND_TITLES, groupDecisions, shouldShowArchitectureLink } from './decisionsPanelUtils';

// Absolute API base on deployed admins (nginx serves the SPA only — no /api proxy); '' locally → Vite proxy.
const API = `${(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? ''}/api/modules/software-engineer/admin`;

async function api(path: string) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

export default function DecisionsPanel({ projectFilter, onOpenRun }: {
  projectFilter?: string;
  onOpenRun?: (id: string) => void;
}) {
  const [decisions, setDecisions] = useState<any[]>([]);

  const load = useCallback(async () => {
    const qs = projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : '';
    try {
      const d = await api(`/overview/decisions${qs}`);
      setDecisions(d?.decisions ?? []);
    } catch { /* transient fetch error — next refresh tick retries */ }
  }, [projectFilter]);

  useEffect(() => {
    load();
    const ch = supabase.channel('se-overview-decisions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'se_runs' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  if (decisions.length === 0) return null;

  const grouped = groupDecisions(decisions);

  return (
    <section className="rounded-lg border border-[var(--gray-5)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">Decisions needed</div>
        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full bg-red-100 px-1.5 text-xs font-medium text-red-700">
          {decisions.length}
        </span>
      </div>
      <div className="space-y-4">
        {grouped.map(([kind, rows]) => (
          <div key={kind} className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-9)]">{KIND_TITLES[kind]}</div>
            <div className="space-y-1">
              {rows.map((d) => {
                const showProposalLink = shouldShowArchitectureLink(kind, d);
                const body = (
                  <>
                    <div className="flex items-center gap-2 min-w-0">
                      <ProjectAvatar emoji={d.project?.avatar_emoji} className="size-4 shrink-0" />
                      <div className="min-w-0">
                        <div className="truncate text-sm text-[var(--gray-12)]">{runLabel(d)}</div>
                        <div className="truncate text-xs text-[var(--gray-10)]">{d.decision}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {showProposalLink && (
                        <a
                          href={d.architecture_commit_url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs text-blue-600 underline hover:text-blue-700"
                        >
                          view proposal
                        </a>
                      )}
                      {formatDuration(d.updated_at) && <span className="text-xs tabular-nums text-[var(--gray-10)]">{formatDuration(d.updated_at)} waiting</span>}
                      {fmtCost(d.cost_usd) && <span className="text-xs font-mono text-[var(--gray-10)]">{fmtCost(d.cost_usd)}</span>}
                    </div>
                  </>
                );
                return onOpenRun ? (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onOpenRun(d.id)}
                    className="w-full flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--gray-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    {body}
                  </button>
                ) : (
                  <div key={d.id} className="flex items-center justify-between gap-3 px-2 py-1.5">{body}</div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
