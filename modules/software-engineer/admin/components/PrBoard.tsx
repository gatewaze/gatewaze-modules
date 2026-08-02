// @ts-nocheck
/**
 * Overview PR board — every open PR authored by each project's PAT user (agent-driven AND
 * external), grouped by WHO ACTS NEXT with a derived status chip + one-line explanation, so the
 * operator never has to open a PR to know where it stands. Data: GET /overview/prs (server-side
 * enriched + classified + cached ~60s). Groups follow the classifier's `actor`:
 *   Needs you → Agent working → Automatic → Other.
 * Admin design system (Tailwind + Radix gray vars); colour never the only signal — every chip
 * carries its text label. No @radix-ui/themes import (module Radix-singleton hazard).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { isGatewayError, StartingBanner } from './starting';
import {
  ArrowPathIcon, ArrowTopRightOnSquareIcon, UserIcon, CpuChipIcon, BoltIcon, MinusCircleIcon,
} from '@heroicons/react/24/outline';

const API = '/api/modules/software-engineer/admin';

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

// Derived-status chips. Text label always present; colour reinforces, never replaces it.
const STATUS_CHIP: Record<string, string> = {
  awaiting_review: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  awaiting_merge: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  changes_requested: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  conflicts: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  ci_failing: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  blocked: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  behind: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  ci_running: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  agent_revising: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  auto_merge_pending: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  draft: 'bg-[var(--gray-4)] text-[var(--gray-11)]',
  unknown: 'bg-[var(--gray-4)] text-[var(--gray-11)]',
};

const GROUPS: Array<{ actor: string; title: string; icon: React.ReactNode; hint: string }> = [
  { actor: 'you', title: 'Needs you', icon: <UserIcon className="size-4" />, hint: 'A human must review, merge, or unblock these.' },
  { actor: 'agent', title: 'Agent working', icon: <CpuChipIcon className="size-4" />, hint: 'An active run owns the next step.' },
  { actor: 'auto', title: 'Automatic', icon: <BoltIcon className="size-4" />, hint: 'The platform progresses these unaided.' },
  { actor: 'none', title: 'Other', icon: <MinusCircleIcon className="size-4" />, hint: 'Nothing to do right now.' },
];

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function PrRow({ pr }: { pr: any }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-[var(--gray-4)] px-3 py-2 hover:border-[var(--gray-7)] transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CHIP[pr.status] ?? STATUS_CHIP.unknown}`}>
          {pr.label}
        </span>
        <a
          href={pr.url} target="_blank" rel="noreferrer"
          className="flex items-center gap-1 min-w-0 text-sm text-[var(--gray-12)] hover:underline"
          title={`${pr.repo}#${pr.number} — ${pr.title}`}
        >
          <span className="truncate font-medium">{pr.title}</span>
          <ArrowTopRightOnSquareIcon className="size-3.5 shrink-0 text-[var(--gray-9)]" />
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--gray-10)]">
        <span className="font-mono">{pr.repo}#{pr.number}</span>
        {pr.run
          ? <span>issue #{pr.run.issue_number}{pr.run.engineer_name ? ` · ${pr.run.engineer_name}` : ''} · blast {pr.run.blast_radius}</span>
          : <span className="text-[var(--gray-9)]">external</span>}
        {Number.isFinite(pr.additions) && <span className="tabular-nums"><span className="text-green-600">+{pr.additions}</span> <span className="text-red-600">−{pr.deletions}</span></span>}
        {pr.checks?.total > 0 && (
          <span className="tabular-nums">
            checks {pr.checks.total - pr.checks.failing - pr.checks.pending}/{pr.checks.total}
            {pr.checks.failing > 0 && <span className="text-red-600"> ({pr.checks.failing} failing)</span>}
          </span>
        )}
        <span>updated {timeAgo(pr.updated_at)} ago</span>
      </div>
      <div className="text-xs text-[var(--gray-11)]">{pr.detail}</div>
    </div>
  );
}

export default function PrBoard({ projectFilter }: { projectFilter?: string }) {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      const params = new URLSearchParams();
      if (projectFilter) params.set('project', projectFilter);
      if (force) params.set('refresh', '1');
      const qs = params.toString() ? `?${params.toString()}` : '';
      setData(await api(`/overview/prs${qs}`)); setErr(null); setStarting(false);
    } catch (e: any) {
      // Stack restarts briefly 502 every request — show "starting up" + retry, not a raw error.
      if (isGatewayError(e)) { setStarting(true); setErr(null); }
      else { setErr(String(e.message ?? e)); setStarting(false); }
    }
    finally { setLoading(false); setRefreshing(false); }
  }, [projectFilter]);

  useEffect(() => {
    setLoading(true);
    load();
    // Poll at the server cache TTL — the board tracks live GitHub state, not just our DB.
    timer.current = setInterval(() => load(), 60_000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  // While the stack is coming up, poll faster than the 60s TTL so the board recovers promptly.
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => load(), 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  const prs: any[] = data?.prs ?? [];
  const projectErrors = data?.project_errors ?? {};

  return (
    <section className="rounded-lg border border-[var(--gray-5)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">
          Pull requests — everything the project users have open
        </div>
        <button
          type="button"
          onClick={() => { setRefreshing(true); load(true); }}
          className="flex items-center gap-1 text-xs text-[var(--gray-10)] hover:text-[var(--gray-12)]"
          aria-label="Refresh pull requests from GitHub"
        >
          <ArrowPathIcon className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {data?.generated_at ? `as of ${timeAgo(data.generated_at)} ago` : 'refresh'}
        </button>
      </div>

      {starting && <StartingBanner label="The platform is starting up — reconnecting…" />}
      {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">{err}</div>}
      {Object.entries(projectErrors).map(([name, msg]) => (
        <div key={name} className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">{name}: {String(msg)}</div>
      ))}

      {loading && !data ? (
        <div className="p-6 text-center text-sm text-[var(--gray-10)]">Loading pull requests from GitHub…</div>
      ) : prs.length === 0 ? (
        <div className="p-6 text-center text-sm text-[var(--gray-10)]">No open PRs authored by the project users.</div>
      ) : (
        <div className="space-y-4">
          {GROUPS.map((g) => {
            const rows = prs.filter((pr) => pr.actor === g.actor);
            if (rows.length === 0) return null;
            return (
              <div key={g.actor} className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--gray-11)]" title={g.hint}>
                  {g.icon}{g.title}
                  <span className="tabular-nums text-[var(--gray-9)]">({rows.length})</span>
                </div>
                {rows.map((pr) => <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />)}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
