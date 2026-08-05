// @ts-nocheck
/**
 * Software Engineer — Overview tab (SPEC.md §14). Read-only, at-a-glance health of the agent fleet:
 * KPI tiles (active work, merged throughput, open PRs, failures, token spend) plus
 * status / pipeline-phase / per-project rollups. One aggregated payload from GET /overview (the
 * se_overview() SQL function), refreshed live when se_runs changes. Optional project filter.
 *
 * Visuals follow the admin design system (Tailwind + Radix gray vars) and the reserved status
 * palette — every colored bar carries an adjacent text label + count, never colour alone.
 * No @radix-ui/themes import (module Radix-singleton hazard).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  CommandLineIcon, CheckCircleIcon, ArrowTopRightOnSquareIcon,
  ExclamationTriangleIcon, CpuChipIcon, Cog6ToothIcon, CurrencyDollarIcon,
} from '@heroicons/react/24/outline';
import { CARD_FILTERS, statusesToParam, fmtCost } from './overview-filters';
import { ProjectAvatar } from './ProjectAvatar';
import { projectOptionLabel } from './projectAvatarUtils';
import PrBoard from './PrBoard';
import { isGatewayError, StartingBanner } from './starting';
import PendingApprovals from './PendingApprovals';
import TestEnvStrip from './TestEnvStrip';

// Absolute API base on deployed admins (nginx serves the SPA only — no /api proxy); '' locally → Vite proxy.
const API = `${(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? ''}/api/modules/software-engineer/admin`;

async function api(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    ...init, credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  if (!r.ok) {
    const e = new Error(`${init?.method ?? 'GET'} ${path} → ${r.status}`) as Error & { status?: number };
    e.status = r.status;
    throw e;
  }
  return r.status === 204 ? null : r.json();
}


// Reserved status palette (matches the Runs board). Bars ship this colour WITH a text label.
const STATUS_BAR: Record<string, string> = {
  merged: 'bg-green-500', pr_open: 'bg-amber-500', watching: 'bg-blue-500', changes_requested: 'bg-amber-500',
  running: 'bg-blue-500', queued: 'bg-[var(--gray-8)]', failed: 'bg-red-500', blocked: 'bg-red-500',
  closed: 'bg-[var(--gray-7)]', cancelled: 'bg-[var(--gray-7)]',
};
const PHASE_BAR = 'bg-blue-500';

const nf = new Intl.NumberFormat('en-US');
function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return nf.format(n);
}

// A KPI tile. When `onClick` is supplied the tile renders as an accessible <button> that opens the
// Runs board filtered to this metric's runs; otherwise it's a static <div> (Tokens — no natural
// run subset). Colour is never the only signal: every tile carries its icon + text label.
function Tile({ icon, label, value, sub, tone, onClick }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; tone?: 'default' | 'danger' | 'good';
  onClick?: () => void;
}) {
  const valueColor = tone === 'danger' ? 'text-red-600' : tone === 'good' ? 'text-green-600' : 'text-[var(--gray-12)]';
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--gray-10)]">
        {icon}{label}
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${valueColor}`}>{value}</div>
      {sub && <div className="text-xs text-[var(--gray-10)]">{sub}</div>}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label} — view matching runs`}
        className="rounded-lg border border-[var(--gray-5)] p-4 flex flex-col gap-1 text-left transition-colors cursor-pointer hover:border-[var(--gray-8)] hover:bg-[var(--gray-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {body}
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--gray-5)] p-4 flex flex-col gap-1">
      {body}
    </div>
  );
}

// Horizontal proportion bar with an always-present text label + count (identity is never colour-alone).
function BarRow({ label, count, max, barClass }: { label: React.ReactNode; count: number; max: number; barClass: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-40 shrink-0 truncate text-[var(--gray-11)]">{label}</div>
      <div className="flex-1 h-2 rounded-full bg-[var(--gray-3)] overflow-hidden">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-12 shrink-0 text-right tabular-nums text-[var(--gray-12)]">{nf.format(count)}</div>
    </div>
  );
}

export default function OverviewView({ onGoToSetup, onOpenRuns }: {
  onGoToSetup?: () => void;
  // Open the Runs board filtered to a status set (comma-separated `?status=` param), carrying the
  // Overview's current project scope. When absent, the count tiles render non-interactive.
  onOpenRuns?: (statusParam: string, project?: string) => void;
}) {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectFilter, setProjectFilter] = useState('');   // '' = all projects
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => { api('/projects').then((d) => setProjects(d.projects ?? [])).catch(() => {}); }, []);

  const load = useCallback(async () => {
    try {
      const qs = projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : '';
      setData(await api(`/overview${qs}`)); setErr(null); setStarting(false);
    } catch (e: any) {
      // A restarting stack briefly 502s every request; surface that as "starting up" (with the
      // retry effect below re-polling) instead of a raw error the operator can't act on.
      if (isGatewayError(e)) { setStarting(true); setErr(null); }
      else { setErr(String(e.message ?? e)); setStarting(false); }
    }
    finally { setLoading(false); }
  }, [projectFilter]);

  useEffect(() => {
    load();
    const ch = supabase.channel('se-overview')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'se_runs' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  // While the stack is coming up, poll until the API answers again.
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  const totals = data?.totals ?? {};
  const byStatus: any[] = data?.by_status ?? [];
  const byPhase: any[] = data?.by_phase ?? [];
  const byProject: any[] = data?.by_project ?? [];
  const spend = data?.spend;
  const statusMax = byStatus.reduce((m, r) => Math.max(m, r.count), 0);
  const phaseMax = byPhase.reduce((m, r) => Math.max(m, r.count), 0);
  const showProjectFilter = projects.length > 1;

  // Open the Runs board scoped to a KPI card's status set + the current project filter. Undefined
  // when no navigation handler is wired, which leaves the count tiles non-interactive.
  const openRuns = onOpenRuns
    ? (statuses: readonly string[]) => onOpenRuns(statusesToParam(statuses), projectFilter || undefined)
    : undefined;

  return (
    <div className="space-y-6">
      <TestEnvStrip />
      {showProjectFilter && (
        <select
          value={projectFilter}
          onChange={(e) => { setLoading(true); setProjectFilter(e.target.value); }}
          className="rounded-md border border-[var(--gray-6)] bg-transparent px-2 py-1.5 text-sm"
        >
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{projectOptionLabel(p.avatar_emoji, p.name)}</option>)}
        </select>
      )}

      {starting && <StartingBanner label="The platform is starting up — reconnecting…" />}
      {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">{err}</div>}

      {/* Human approvals (pending reflect memory + unmerged-run specs) — surfaced here because this
          is the page operators watch; renders nothing when there is nothing to review. */}
      <PendingApprovals projects={projects} />

      {loading && !data ? (
        <div className="flex justify-center p-12"><LoadingSpinner /></div>
      ) : (totals.runs ?? 0) === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center space-y-3">
          <CommandLineIcon className="size-8 mx-auto text-[var(--gray-8)]" />
          <p className="font-medium text-[var(--gray-12)]">No runs yet</p>
          <p className="text-xs leading-relaxed text-[var(--gray-11)]">
            Metrics appear here once the agent starts working issues.<br />
            Add a project’s GitHub + model credentials and a repo in <strong>Setup</strong>, then label an issue.
          </p>
          {onGoToSetup && (
            <Button variant="solid" size="sm" onClick={onGoToSetup}><Cog6ToothIcon className="size-4 mr-1" />Go to Setup</Button>
          )}
          {/* PR board scope: only PRs authored by each project's PAT user on that project's
              CONNECTED code repos — never the token's wider visible universe. */}
          <div className="text-left pt-6"><PrBoard projectFilter={projectFilter} /></div>
        </div>
      ) : (
        <>
          {/* KPI tiles */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <Tile icon={<CommandLineIcon className="size-3.5" />} label="Active" value={nf.format(totals.active ?? 0)} sub="in flight" onClick={openRuns && (() => openRuns(CARD_FILTERS.active.statuses))} />
            <Tile icon={<CheckCircleIcon className="size-3.5" />} label="Merged" value={nf.format(totals.merged_30d ?? 0)} sub="last 30 days" tone={(totals.merged_30d ?? 0) > 0 ? 'good' : 'default'} onClick={openRuns && (() => openRuns(CARD_FILTERS.merged.statuses))} />
            <Tile icon={<ArrowTopRightOnSquareIcon className="size-3.5" />} label="Open PRs" value={nf.format(totals.open_prs ?? 0)} sub="awaiting review/merge" onClick={openRuns && (() => openRuns(CARD_FILTERS.open_prs.statuses))} />
            <Tile icon={<ExclamationTriangleIcon className="size-3.5" />} label="Failed / blocked" value={nf.format(totals.failed_blocked ?? 0)} tone={(totals.failed_blocked ?? 0) > 0 ? 'danger' : 'default'} sub="need attention" onClick={openRuns && (() => openRuns(CARD_FILTERS.failed_blocked.statuses))} />
            <Tile icon={<CpuChipIcon className="size-3.5" />} label="Tokens" value={fmtTokens((totals.tokens_input ?? 0) + (totals.tokens_output ?? 0))} sub={`${fmtTokens(totals.tokens_input ?? 0)} in · ${fmtTokens(totals.tokens_output ?? 0)} out`} />
            {/* Absent (not $0.00) when there's no costed data — pre-012 instance, or no runs priced yet. */}
            {fmtCost(spend?.total_30d) && (
              <Tile
                icon={<CurrencyDollarIcon className="size-3.5" />}
                label="Model spend"
                value={fmtCost(spend.total_30d)}
                sub={fmtCost(spend.total_7d) ? `${fmtCost(spend.total_7d)} last 7 days` : 'no spend last 7 days'}
              />
            )}
          </div>

          {/* PR board — the live "where is every PR + who acts next" view */}
          <PrBoard projectFilter={projectFilter} />

          {/* Status + phase breakdowns */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="rounded-lg border border-[var(--gray-5)] p-4 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">Runs by status</div>
              {byStatus.length === 0 ? <div className="text-sm text-[var(--gray-10)]">No runs.</div>
                : <div className="space-y-2">{byStatus.map((r) => (
                    <BarRow key={r.status} label={r.status} count={r.count} max={statusMax} barClass={STATUS_BAR[r.status] ?? 'bg-[var(--gray-8)]'} />
                  ))}</div>}
            </section>

            <section className="rounded-lg border border-[var(--gray-5)] p-4 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">Active work by phase</div>
              {byPhase.length === 0 ? <div className="text-sm text-[var(--gray-10)]">Nothing in flight.</div>
                : <div className="space-y-2">{byPhase.map((r) => (
                    <BarRow key={r.phase} label={r.phase} count={r.count} max={phaseMax} barClass={PHASE_BAR} />
                  ))}</div>}
            </section>
          </div>

          {/* Per-project rollup — only meaningful when not already filtered to one project */}
          {!projectFilter && byProject.length > 1 && (
            <section className="rounded-lg border border-[var(--gray-5)] p-4 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">By project</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-[var(--gray-10)] border-b border-[var(--gray-5)]">
                      <th className="py-1.5 pr-3 font-medium">Project</th>
                      <th className="py-1.5 px-3 font-medium text-right">Total</th>
                      <th className="py-1.5 px-3 font-medium text-right">Active</th>
                      <th className="py-1.5 px-3 font-medium text-right">Merged</th>
                      <th className="py-1.5 px-3 font-medium text-right">Failed/blocked</th>
                      <th className="py-1.5 pl-3 font-medium text-right">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byProject.map((p) => (
                      <tr key={p.project_id} className="border-b border-[var(--gray-3)] last:border-0">
                        <td className="py-1.5 pr-3 text-[var(--gray-12)] truncate"><span className="inline-flex items-center gap-1"><ProjectAvatar emoji={p.avatar_emoji} className="size-4" /> {p.name ?? '—'}</span></td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-[var(--gray-12)]">{nf.format(p.total ?? 0)}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-[var(--gray-11)]">{nf.format(p.active ?? 0)}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-green-600">{nf.format(p.merged ?? 0)}</td>
                        <td className={`py-1.5 px-3 text-right tabular-nums ${(p.failed_blocked ?? 0) > 0 ? 'text-red-600' : 'text-[var(--gray-11)]'}`}>{nf.format(p.failed_blocked ?? 0)}</td>
                        <td className="py-1.5 pl-3 text-right tabular-nums text-[var(--gray-11)]">{fmtTokens((p.tokens_input ?? 0) + (p.tokens_output ?? 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Model spend by project — its own desc-by-spend ordering, computed server-side in
              computeSpendOverview() (lib/cost.ts), independent of the tokens rollup above. */}
          {!projectFilter && (spend?.by_project?.length ?? 0) > 1 && (
            <section className="rounded-lg border border-[var(--gray-5)] p-4 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">Model spend by project</div>
              {spend.by_project.map((p: any) => (
                <div key={p.project_id} className="flex items-center justify-between text-sm">
                  <span className="inline-flex items-center gap-1.5 text-[var(--gray-12)]">
                    <ProjectAvatar emoji={p.avatar_emoji} className="size-4" /> {p.name ?? '—'}
                  </span>
                  <span className="font-mono text-[var(--gray-11)]">{fmtCost(p.total)}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
