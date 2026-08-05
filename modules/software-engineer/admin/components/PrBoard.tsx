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
import { timeAgo, formatSubmittedDate } from '../lib/pr-format';
import {
  ArrowPathIcon, ArrowTopRightOnSquareIcon, UserIcon, UsersIcon, CpuChipIcon, BoltIcon,
  MinusCircleIcon, BellAlertIcon, LinkIcon, BeakerIcon, PaperAirplaneIcon,
} from '@heroicons/react/24/outline';
import { DEPLOYABLE, deployTestEnv, fetchRelated, useTestEnvStatus } from './testEnv';

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
  { actor: 'you', title: 'Needs you', icon: <UserIcon className="size-4" />, hint: 'You can act on these: address changes on your PR, fix CI, or merge (where you have write access).' },
  { actor: 'reviewers', title: 'Awaiting reviewers', icon: <UsersIcon className="size-4" />, hint: 'On your own PRs — waiting on a required review or a maintainer to merge. You can nudge them.' },
  { actor: 'agent', title: 'Agent working', icon: <CpuChipIcon className="size-4" />, hint: 'An active run owns the next step.' },
  { actor: 'auto', title: 'Automatic', icon: <BoltIcon className="size-4" />, hint: 'The platform progresses these unaided.' },
  { actor: 'none', title: 'Other', icon: <MinusCircleIcon className="size-4" />, hint: 'Nothing to do right now.' },
];

// Red / amber / green left-edge accent by CI state, so health is visible at a glance without reading
// the checks text. Colour reinforces the always-present textual chip + checks count, never replaces it.
function checkAccent(pr: any): string {
  const c = pr.checks;
  if (pr.status === 'merged') return 'border-l-green-500';
  if (pr.status === 'closed') return 'border-l-[var(--gray-6)]';
  if (!c || !c.total) return 'border-l-[var(--gray-5)]';   // no checks reported
  if (c.failing > 0) return 'border-l-red-500';
  if (c.pending > 0) return 'border-l-amber-500';
  return 'border-l-green-500';                              // all checks green
}

function PrRow({ pr, onChanged, testEnvAvailable }: { pr: any; onChanged?: () => void; testEnvAvailable?: boolean }) {
  const [notify, setNotify] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [notifyMsg, setNotifyMsg] = useState('');
  const [connect, setConnect] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [connectMsg, setConnectMsg] = useState('');
  const [deploying, setDeploying] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [deployMsg, setDeployMsg] = useState('');
  // "Deploy to test" — deployable repos only; replaces the current test env
  // (single slot). Related PRs (same head branch in the other repos) are
  // auto-included; the run view offers finer-grained selection.
  const [prOwner, prName] = String(pr.repo).split('/');
  const canDeployTest = !!testEnvAvailable && prOwner === 'gatewaze' && DEPLOYABLE.includes(prName)
    && pr.status !== 'merged' && pr.status !== 'closed';
  const doDeployTest = async () => {
    if (deploying === 'sending') return;
    setDeploying('sending'); setDeployMsg('');
    try {
      let set = [{ repo: prName, number: pr.number }];
      if (pr.project_id) {
        try {
          const rel = await fetchRelated(String(pr.project_id), prName, pr.number);
          for (const r of rel?.related ?? []) {
            if (!set.some((x) => x.repo === r.repo)) set.push({ repo: r.repo, number: r.number });
          }
        } catch { /* best-effort — deploy the single PR */ }
      }
      await deployTestEnv(set);
      setDeploying('done');
      setDeployMsg(`Deploying ${set.map((s) => `${s.repo}#${s.number}`).join(' + ')} — replaces the current test env. Watch progress on any run or above.`);
    } catch (e: any) {
      setDeploying('error');
      setDeployMsg(/403/.test(String(e?.message)) ? 'Super-admin access required.' : /409/.test(String(e?.message)) ? 'A test-env operation is already in progress.' : 'Could not request the deploy.');
    }
  };
  const reviewers: string[] = Array.isArray(pr.reviewers) ? pr.reviewers : [];
  const canNotify = pr.actor === 'reviewers' && !!pr.project_id;
  // An external PR (no linked run) that's still open can be CONNECTED to a watching run: the agent
  // then tracks it and auto-revises on trusted review feedback (a human still merges).
  const canConnect = !pr.run && !!pr.project_id && pr.status !== 'merged' && pr.status !== 'closed' && connect !== 'done';

  const doConnect = async () => {
    if (connect === 'sending') return;
    const [owner, name] = String(pr.repo).split('/');
    setConnect('sending'); setConnectMsg('');
    try {
      const q = new URLSearchParams({ project: String(pr.project_id), owner, name, number: String(pr.number) });
      await api(`/prs/connect?${q.toString()}`, { method: 'POST' });
      setConnect('done'); setConnectMsg('Connected — a runner is now watching this PR for reviews.');
      onChanged?.();
    } catch (e: any) {
      setConnect('error');
      setConnectMsg(e?.status === 409 ? 'This PR is closed or already connected.' : 'Could not connect this PR.');
    }
  };

  const doNotify = async () => {
    if (notify === 'sending') return;
    const [owner, name] = String(pr.repo).split('/');
    setNotify('sending'); setNotifyMsg('');
    try {
      const q = new URLSearchParams({ project: String(pr.project_id), owner, name, number: String(pr.number) });
      const r = await api(`/prs/notify-reviewers?${q.toString()}`, { method: 'POST' });
      const n = (r?.reviewers?.length ?? 0) + (r?.teams?.length ?? 0);
      setNotify('done'); setNotifyMsg(`Pinged ${n} reviewer${n === 1 ? '' : 's'} on the PR.`);
    } catch (e: any) {
      setNotify('error');
      setNotifyMsg(e?.status === 409 ? 'No reviewers requested on this PR yet — request one on GitHub first.' : 'Could not post the reminder.');
    }
  };

  return (
    <div className={`flex flex-col gap-1 rounded-md border border-l-4 border-[var(--gray-4)] ${checkAccent(pr)} px-3 py-2 hover:border-[var(--gray-7)] transition-colors`}>
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
        {pr.author && (
          <a href={`https://github.com/${pr.author}`} target="_blank" rel="noreferrer" className="hover:underline" title={`Opened by @${pr.author}`}>
            by <span className="font-medium text-[var(--gray-11)]">@{pr.author}</span>
          </a>
        )}
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
        {reviewers.length > 0 && (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="text-[var(--gray-9)]">reviewers</span>
            {reviewers.slice(0, 4).map((r) => (
              <span key={r} className="rounded bg-[var(--gray-3)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--gray-11)]">@{r}</span>
            ))}
            {reviewers.length > 4 && <span className="text-[var(--gray-9)]">+{reviewers.length - 4}</span>}
          </span>
        )}
        {pr.created_at && formatSubmittedDate(pr.created_at) && (
          <span title={`Originally submitted ${formatSubmittedDate(pr.created_at)}`}>
            Submitted on {formatSubmittedDate(pr.created_at)} ({timeAgo(pr.created_at)} ago)
          </span>
        )}
        <span>updated {timeAgo(pr.updated_at)} ago</span>
      </div>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-[var(--gray-11)]">{pr.detail}</div>
        <div className="flex items-center gap-2 shrink-0">
          {canConnect && (
            <button
              type="button" onClick={doConnect} disabled={connect === 'sending'}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--gray-6)] px-2 py-1 text-xs text-[var(--gray-11)] hover:bg-[var(--gray-3)] disabled:opacity-50"
              title="Have a runner watch this externally-opened PR and auto-address review feedback (a human still merges)"
            >
              <LinkIcon className="size-3.5" />
              {connect === 'sending' ? 'Connecting…' : 'Connect'}
            </button>
          )}
          {connect === 'done' && <span className="inline-flex items-center gap-1 text-xs text-[var(--gray-10)]"><CpuChipIcon className="size-3.5" />Watching</span>}
          {canNotify && (
            <button
              type="button" onClick={doNotify} disabled={notify === 'sending' || notify === 'done'}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--gray-6)] px-2 py-1 text-xs text-[var(--gray-11)] hover:bg-[var(--gray-3)] disabled:opacity-50"
              title="Post a comment on the PR @-mentioning its requested reviewers"
            >
              <BellAlertIcon className="size-3.5" />
              {notify === 'sending' ? 'Notifying…' : notify === 'done' ? 'Notified ✓' : 'Notify reviewers'}
            </button>
          )}
          {canDeployTest && (
            <button
              type="button" onClick={doDeployTest} disabled={deploying === 'sending'}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--gray-6)] px-2 py-1 text-xs text-[var(--gray-11)] hover:bg-[var(--gray-3)] disabled:opacity-50"
              title="Deploy this PR (plus auto-detected related PRs) to the test environment — replaces whatever is currently deployed there"
            >
              <BeakerIcon className="size-3.5" />
              {deploying === 'sending' ? 'Deploying…' : deploying === 'done' ? 'Deploy requested ✓' : 'Deploy to test'}
            </button>
          )}
        </div>
      </div>
      {connectMsg && <div className={`text-[11px] ${connect === 'error' ? 'text-red-600' : 'text-[var(--gray-10)]'}`}>{connectMsg}</div>}
      {notifyMsg && <div className={`text-[11px] ${notify === 'error' ? 'text-red-600' : 'text-[var(--gray-10)]'}`}>{notifyMsg}</div>}
      {deployMsg && <div className={`text-[11px] ${deploying === 'error' ? 'text-red-600' : 'text-[var(--gray-10)]'}`}>{deployMsg}</div>}
    </div>
  );
}

// A run whose code is complete but whose PR submission is human-gated (pr_submit_mode='manual'). It has
// no GitHub PR yet, so it renders from the DB with a Submit action that opens the pull request.
function NeedsSubmitRow({ run, onSubmitted }: { run: any; onSubmitted?: () => void }) {
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const doSubmit = async () => {
    if (state === 'sending') return;
    if (!window.confirm('Submit the pull request now? This opens it on the code repository.')) return;
    setState('sending'); setMsg('');
    try {
      await api(`/runs/${run.run_id}/submit-pr`, { method: 'POST' });
      setMsg('Submitting the pull request…'); onSubmitted?.();
    } catch (e: any) {
      setState('error');
      setMsg(e?.status === 409 ? 'This run is no longer ready to submit.' : 'Could not submit the pull request.');
    }
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border border-l-4 border-[var(--gray-4)] border-l-amber-500 px-3 py-2">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[var(--gray-12)]">{run.title || `Issue #${run.issue_number}`}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--gray-10)]">
            <span className="font-mono">{run.repo}</span>
            {run.issue_number != null && <span>issue #{run.issue_number}</span>}
            {run.project_name && <span>{run.project_name}</span>}
            {run.blast_radius && <span>blast {run.blast_radius}</span>}
            {run.updated_at && <span>updated {timeAgo(run.updated_at)} ago</span>}
          </div>
        </div>
        <button
          type="button" onClick={doSubmit} disabled={state === 'sending'}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--gray-6)] px-2 py-1 text-xs text-[var(--gray-11)] hover:bg-[var(--gray-3)] disabled:opacity-50"
          title="Open the pull request the agent prepared"
        >
          <PaperAirplaneIcon className="size-3.5" />{state === 'sending' ? 'Submitting…' : 'Submit PR'}
        </button>
      </div>
      {msg && <div className={`text-[11px] ${state === 'error' ? 'text-red-600' : 'text-[var(--gray-10)]'}`}>{msg}</div>}
    </div>
  );
}

export default function PrBoard({ projectFilter }: { projectFilter?: string }) {
  // One status probe for the whole board — rows only render "Deploy to test"
  // where the deployment actually has a test-env channel.
  const { info: testEnvInfo } = useTestEnvStatus();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Default: only the PAT user's own PRs (fewer GitHub calls; "who acts next" is really your work).
  // Toggle to show everyone's open PRs in the connected repos.
  const [showAll, setShowAll] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      const params = new URLSearchParams();
      if (projectFilter) params.set('project', projectFilter);
      if (showAll) params.set('all', '1');
      if (force) params.set('refresh', '1');
      const qs = params.toString() ? `?${params.toString()}` : '';
      setData(await api(`/overview/prs${qs}`)); setErr(null); setStarting(false);
    } catch (e: any) {
      // Stack restarts briefly 502 every request — show "starting up" + retry, not a raw error.
      if (isGatewayError(e)) { setStarting(true); setErr(null); }
      else { setErr(String(e.message ?? e)); setStarting(false); }
    }
    finally { setLoading(false); setRefreshing(false); }
  }, [projectFilter, showAll]);

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
  const needsSubmitting: any[] = data?.needs_submitting ?? [];
  const projectErrors = data?.project_errors ?? {};

  return (
    <section className="rounded-lg border border-[var(--gray-5)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">
          Pull requests — {showAll ? 'everyone’s, in the connected repos' : 'yours'}
        </div>
        <div className="flex items-center gap-3">
          {/* Scope toggle: your PRs (default) ↔ everyone's open PRs in the connected repos. */}
          <div className="inline-flex rounded-md border border-[var(--gray-6)] overflow-hidden text-xs">
            <button
              type="button" onClick={() => setShowAll(false)}
              className={`px-2 py-0.5 ${!showAll ? 'bg-[var(--gray-4)] text-[var(--gray-12)] font-medium' : 'text-[var(--gray-10)] hover:bg-[var(--gray-3)]'}`}
              title="Only PRs you (the PAT user) opened"
            >Mine</button>
            <button
              type="button" onClick={() => setShowAll(true)}
              className={`px-2 py-0.5 border-l border-[var(--gray-6)] ${showAll ? 'bg-[var(--gray-4)] text-[var(--gray-12)] font-medium' : 'text-[var(--gray-10)] hover:bg-[var(--gray-3)]'}`}
              title="Every open PR in the connected repos (more GitHub calls)"
            >All</button>
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
      </div>

      {starting && <StartingBanner label="The platform is starting up — reconnecting…" />}
      {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">{err}</div>}
      {Object.entries(projectErrors).map(([name, msg]) => (
        <div key={name} className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">{name}: {String(msg)}</div>
      ))}

      {loading && !data ? (
        <div className="p-6 text-center text-sm text-[var(--gray-10)]">Loading pull requests from GitHub…</div>
      ) : (
        <div className="space-y-4">
          {/* Needs submitting: code complete, PR held for a human to open (pr_submit_mode='manual'). */}
          {needsSubmitting.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--gray-11)]" title="Code is complete and the branch is pushed. Submit to open the pull request.">
                <PaperAirplaneIcon className="size-4" />Needs submitting
                <span className="tabular-nums text-[var(--gray-9)]">({needsSubmitting.length})</span>
              </div>
              {needsSubmitting.map((r) => <NeedsSubmitRow key={r.run_id} run={r} onSubmitted={() => load(true)} />)}
            </div>
          )}
          {prs.length === 0 && needsSubmitting.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--gray-10)]">No open PRs authored by the project users.</div>
          ) : (
            GROUPS.map((g) => {
              const rows = prs.filter((pr) => pr.actor === g.actor);
              if (rows.length === 0) return null;
              return (
                <div key={g.actor} className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--gray-11)]" title={g.hint}>
                    {g.icon}{g.title}
                    <span className="tabular-nums text-[var(--gray-9)]">({rows.length})</span>
                  </div>
                  {rows.map((pr) => <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} onChanged={() => load(true)} testEnvAvailable={!!testEnvInfo?.available} />)}
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
