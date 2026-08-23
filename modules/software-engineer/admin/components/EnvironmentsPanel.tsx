// @ts-nocheck
/**
 * Overview "Environments" section for the lfx profile — the primary env card
 * (the existing <TestEnvOverviewPanel>, pinned to lfx.pr-view.com) plus one
 * card per hostname-keyed registry env from GET /test-env/envs, a
 * "New environment" mini-form (ordered Tier-A set builder → live label
 * preview from the shared grammar encoder), and the Activity/Errors timeline
 * fed by the box's events.jsonl (ingested server-side on every list poll).
 *
 * Follows the admin design system (Tailwind + Radix gray vars); no
 * @radix-ui/themes import (module Radix-singleton hazard).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { toast } from 'sonner';
import {
  GlobeAltIcon, ArrowTopRightOnSquareIcon, ArrowPathIcon, TrashIcon, BoltIcon, PlusIcon, ClockIcon,
  ChevronUpIcon, ChevronDownIcon,
} from '@heroicons/react/24/outline';
import TestEnvOverviewPanel from './TestEnvOverviewPanel';
import EnvLogExplorer from './EnvLogExplorer';
import { ClaritySignals } from './ClaritySignals';
import { listEnvs, createEnv, teardownEnv, refreshEnv, assignRoot, parseTestEnvDetail, relTime, testEnvPrUrl, testEnvCommitUrl } from './testEnv';
import {
  ENV_STEPS, ENV_ACTIVE_STATES, envStepPct, envStateBadge, specChips, fmtCountdown,
} from './envCards';
import { encodeEnvLabel, envTierCheck, ENV_TIER_A } from '../../lib/env-label.js';

const TIER_A_REPOS = [...ENV_TIER_A];
const BADGE_COLOR = { green: 'green', red: 'red', gray: 'gray', blue: 'blue', amber: 'amber' };

function useNow(ms = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ── one env card ─────────────────────────────────────────────────────────────
function EnvCard({ entry, now, onAction, root }) {
  const { label, registry, status: st, pending } = entry;
  const [busy, setBusy] = useState(false);
  const badge = envStateBadge(st?.state, pending);
  const active = pending || ENV_ACTIVE_STATES.has(st?.state);
  const ready = st?.state === 'ready';
  const reaped = st?.state === 'reaped' || registry?.status === 'reaped';
  const detail = parseTestEnvDetail(st?.detail);
  const chips = specChips(registry?.spec);
  // Resolved PR-head shas from the live-tracking status line, keyed repo#pr.
  const heads = {};
  for (const r of detail.repos) for (const pr of r.prs) if (pr.headSha) heads[`${r.repo}#${pr.number}`] = pr.headSha;
  const appHost = registry?.hostnames?.app ?? `${label}.pr-view.com`;
  const countdown = fmtCountdown(registry?.expires_at, now);
  const updatedRel = relTime(st?.updated_at, now);
  const pct = envStepPct(st?.state, pending);

  const act = async (what, fn, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try { await fn(label); toast.success(`${what} requested for ${label}`); onAction(); }
    catch (e) { toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `${what} failed: ${e?.message ?? e}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-md border border-[var(--gray-6)] px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <GlobeAltIcon className="size-4 shrink-0" />
        {reaped ? (
          <span className="text-sm font-medium text-[var(--gray-11)]">{appHost}</span>
        ) : (
          <a href={`https://${appHost}`} target="_blank" rel="noreferrer" className="text-sm font-medium text-blue-500 inline-flex items-center gap-1">
            {appHost} <ArrowTopRightOnSquareIcon className="size-3" />
          </a>
        )}
        <Badge color={BADGE_COLOR[badge.color]} variant="soft" size="1">{badge.label}</Badge>
        {root?.env === label && (
          <Badge color="purple" variant="soft" size="1" title="This environment currently serves lfx.pr-view.com (TTL-exempt while assigned)">
            serving lfx.pr-view.com
          </Badge>
        )}
        {registry?.live && !reaped && (
          <Badge color="green" variant="soft" size="1" title="Re-merged and refreshed automatically on every push">
            <BoltIcon className="size-3 mr-0.5" />Live
          </Badge>
        )}
        {countdown && !reaped && (
          <span
            className={`inline-flex items-center gap-0.5 text-[11px] whitespace-nowrap ${countdown === 'expired' ? 'text-amber-600' : 'text-[var(--gray-10)]'}`}
            title={`TTL from last activity — expires ${registry?.expires_at}. Any tracked push or request through the env hostname resets it.`}
          >
            <ClockIcon className="size-3" />{countdown === 'expired' ? 'expired — reaping soon' : `TTL ${countdown}`}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--gray-10)]">
          {registry?.created_at && <span title={registry.created_at}>created {relTime(registry.created_at, now)}</span>}
          {registry?.last_activity_at && <span title={registry.last_activity_at}>active {relTime(registry.last_activity_at, now)}</span>}
          {updatedRel && <span title={st?.updated_at}>updated {updatedRel}</span>}
          {ready && root?.env !== label && (
            <Button variant="soft" size="xs" disabled={busy || active || root?.pending}
              title="Serve this environment at the root domain lfx.pr-view.com (the primary moves to lfx--main.pr-view.com)"
              onClick={() => act('Root assignment', assignRoot,
                `Serve ${label} at lfx.pr-view.com?\n\nThe flipped apps restart — expect a ~30s blip on the root URL and on this env. The current occupant stays reachable (the primary at lfx--main.pr-view.com).`
                + (registry?.hostnames?.api === `${label}-api.pr-view.com`
                  ? `\n\nNOTE: this env runs its own newsletter service, so the SHARED API host lfx-api.pr-view.com will also route newsletter traffic (including unsubscribe links and tracking pixels in already-sent emails) to this env's PR code until the primary is restored.`
                  : ''))}>
              <GlobeAltIcon className="size-3.5 mr-1" />Serve at root
            </Button>
          )}
          <Button variant="soft" size="xs" onClick={() => act(reaped ? 'Redeploy' : 'Refresh', refreshEnv)} disabled={busy || active}
            title={reaped ? 'Re-create this environment from its registry spec' : 'Redeploy this environment from its registry spec'}>
            <ArrowPathIcon className="size-3.5 mr-1" />{reaped ? 'Redeploy' : 'Refresh'}
          </Button>
          <Button variant="soft" color="red" size="xs" disabled={busy || active || root?.env === label}
            title={root?.env === label ? 'Serving lfx.pr-view.com — restore primary first' : undefined}
            onClick={() => act('Teardown', teardownEnv, `Tear down ${label}?${reaped ? ' (removes the reaped registry entry)' : ''}`)}>
            <TrashIcon className="size-3.5 mr-1" />{reaped ? 'Remove' : 'Tear down'}
          </Button>
        </span>
      </div>

      {chips.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-xs">
          {chips.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1 rounded border border-[var(--gray-5)] px-1.5 py-0.5">
              <span className="text-[var(--gray-11)]">{c.repo}</span>
              {c.pr !== undefined ? (
                <>
                  <a href={testEnvPrUrl('lfx', c.repo, c.pr)} target="_blank" rel="noreferrer" className="text-blue-500">#{c.pr}</a>
                  {heads[`${c.repo}#${c.pr}`] && (
                    <a href={testEnvCommitUrl('lfx', c.repo, heads[`${c.repo}#${c.pr}`])} target="_blank" rel="noreferrer"
                      className="font-mono text-[11px] text-[var(--gray-10)] hover:text-[var(--gray-12)]" title="Resolved PR head — the exact push this env is running">
                      @{heads[`${c.repo}#${c.pr}`].slice(0, 7)}
                    </a>
                  )}
                </>
              ) : (
                <span className="font-mono text-[11px]" title="Branch watch — tracks pushes to this branch">{c.branch}</span>
              )}
            </span>
          ))}
          {registry?.hostnames?.api && (
            <a href={`https://${registry.hostnames.api}`} target="_blank" rel="noreferrer" className="text-[11px] text-blue-500">
              api: {registry.hostnames.api}
            </a>
          )}
        </div>
      )}

      {st?.state === 'error' && (
        // Error detail untruncated — the agent names the failing step /
        // conflict / admission refusal here.
        <div className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300 break-words">
          {st.detail || 'The last operation on this environment failed.'}
        </div>
      )}
      {reaped && (
        <div className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          Reaped after TTL expiry — resources freed, registry kept. Redeploy re-creates it from the same set.
        </div>
      )}
      {st?.state !== 'error' && detail.conflict && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 break-words">
          Live refresh conflict: {detail.conflict}
        </div>
      )}
      {active && (
        <div className="mt-2">
          <div className="h-1.5 rounded-full bg-[var(--gray-4)] overflow-hidden">
            <div className="h-full rounded-full bg-blue-500 transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--gray-10)]">
            <span>
              {ENV_STEPS.filter((s) => !['queued', 'ready'].includes(s.state)).map((s, i, arr) => (
                <span key={s.state}>
                  <span className={s.state === st?.state ? 'text-blue-500 font-medium' : ''}>{s.label}</span>
                  {i < arr.length - 1 ? ' → ' : ''}
                </span>
              ))}
            </span>
            <span>{pct}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── new-environment mini-form ────────────────────────────────────────────────
function NewEnvForm({ onRequested, disabled }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState([]); // {repo, kind:'pr'|'branch', value:string}
  const [live, setLive] = useState(true);
  const [ttl, setTtl] = useState('3');
  const [busy, setBusy] = useState(false);

  const spec = entries
    .map((e) => (e.kind === 'pr'
      ? { repo: e.repo, pr: Number(e.value) }
      : { repo: e.repo, branch: e.value }))
    .filter((e) => ('pr' in e ? Number.isInteger(e.pr) && e.pr >= 1 : e.branch.length > 0));
  const complete = entries.length > 0 && spec.length === entries.length;
  const enc = complete ? encodeEnvLabel(spec) : { label: null, error: null };
  const tierErr = complete && enc.label ? envTierCheck(spec) : null;
  const ttlNum = Number(ttl);
  const ttlOk = ttl === '' || (Number.isInteger(ttlNum) && ttlNum >= 1 && ttlNum <= 168);
  const canCreate = complete && enc.label && !tierErr && ttlOk && !busy && !disabled;

  const move = (i, dir) => setEntries((xs) => {
    const j = i + dir;
    if (j < 0 || j >= xs.length) return xs;
    const next = [...xs];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const create = async () => {
    setBusy(true);
    try {
      const r = await createEnv(spec, live, ttl === '' ? undefined : ttlNum);
      toast.success(`Environment requested: ${r?.label ?? enc.label}`);
      setEntries([]); setOpen(false);
      onRequested();
    } catch (e) {
      toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `Create failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)} disabled={disabled}>
        <PlusIcon className="size-3.5 mr-0.5" />New environment
      </Button>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-[var(--gray-6)] px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--gray-11)]">
        New environment
        <span className="text-[11px] font-normal text-[var(--gray-10)]">ordered set — same merge-queue semantics as the primary slot; Tier-A repos only</span>
        <button onClick={() => setOpen(false)} className="ml-auto text-[var(--gray-10)]">×</button>
      </div>
      {entries.map((e, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs flex-wrap">
          <button title="Deploy earlier" onClick={() => move(i, -1)} className="text-[var(--gray-10)] hover:text-[var(--gray-12)]" disabled={i === 0}><ChevronUpIcon className="size-3" /></button>
          <button title="Deploy later" onClick={() => move(i, 1)} className="text-[var(--gray-10)] hover:text-[var(--gray-12)]" disabled={i === entries.length - 1}><ChevronDownIcon className="size-3" /></button>
          <select value={e.repo} onChange={(ev) => setEntries((xs) => xs.map((y, j) => (j === i ? { ...y, repo: ev.target.value } : y)))} className="rounded border px-1 py-0.5 text-xs">
            {TIER_A_REPOS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={e.kind} onChange={(ev) => setEntries((xs) => xs.map((y, j) => (j === i ? { ...y, kind: ev.target.value, value: '' } : y)))} className="rounded border px-1 py-0.5 text-xs">
            <option value="pr">PR #</option>
            <option value="branch">branch</option>
          </select>
          <input
            value={e.value}
            placeholder={e.kind === 'pr' ? 'PR#' : 'feat/my-branch'}
            onChange={(ev) => setEntries((xs) => xs.map((y, j) => (j === i ? { ...y, value: e.kind === 'pr' ? ev.target.value.replace(/\D/g, '') : ev.target.value } : y)))}
            className={`rounded border px-1 py-0.5 text-xs ${e.kind === 'pr' ? 'w-16' : 'w-44'}`}
          />
          <button onClick={() => setEntries((xs) => xs.filter((_, j) => j !== i))} className="text-[var(--gray-10)]">×</button>
        </div>
      ))}
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <Button variant="ghost" size="xs" onClick={() => setEntries((xs) => [...xs, { repo: TIER_A_REPOS[0], kind: 'pr', value: '' }])}>
          <PlusIcon className="size-3.5 mr-0.5" />add entry
        </Button>
        <label className="inline-flex items-center gap-1.5 text-[var(--gray-11)]" title="Re-merge and refresh the env automatically on every push (default for hostname-keyed envs)">
          <input type="checkbox" className="size-3.5" checked={live} onChange={(e) => setLive(e.target.checked)} />
          <span>Live — follow pushes</span>
        </label>
        <label className="inline-flex items-center gap-1.5 text-[var(--gray-11)]" title="Hours of inactivity (no tracked push, no request through the env hostname) before the env is reaped. 1–168.">
          <span>TTL</span>
          <input value={ttl} onChange={(e) => setTtl(e.target.value.replace(/\D/g, ''))} className="w-10 rounded border px-1 py-0.5 text-xs" />
          <span>h</span>
        </label>
        <Button variant="soft" size="xs" onClick={create} disabled={!canCreate}>
          {busy ? 'Requesting…' : 'Create'}
        </Button>
      </div>
      {/* Live label preview from the shared grammar encoder — the label IS the env identity. */}
      {entries.length > 0 && (
        <div className="text-[11px] break-words">
          {enc.label && !tierErr && (
            <span className="font-mono text-[var(--gray-11)]">{enc.label}.pr-view.com</span>
          )}
          {complete && enc.error && <span className="text-red-600 dark:text-red-400">{enc.error}</span>}
          {tierErr && <span className="text-red-600 dark:text-red-400">{tierErr}</span>}
          {!complete && <span className="text-[var(--gray-10)]">finish the entries above to preview the hostname</span>}
          {!ttlOk && <span className="text-red-600 dark:text-red-400"> · TTL must be 1–168 hours</span>}
        </div>
      )}
    </div>
  );
}

// ── the section ──────────────────────────────────────────────────────────────
export default function EnvironmentsPanel({ projects }) {
  const [info, setInfo] = useState(null);
  const now = useNow();

  const load = useCallback(() => {
    listEnvs().then(setInfo).catch(() => setInfo(null));
  }, []);
  const anyActive = !!info?.envs?.some((e) => e.pending || ENV_ACTIVE_STATES.has(e.status?.state)) || !!info?.root?.pending;
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const interval = anyActive ? 6000 : 30000;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) load();
    }, interval);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [anyActive, load]);

  // No multi-env channel on this deployment: fall back to the primary panel
  // exactly as before (it hides itself too when ITS channel is absent).
  if (!info?.available) return <TestEnvOverviewPanel profile="lfx" projects={projects} />;

  const envs = info.envs ?? [];
  const root = info.root ?? { env: 'primary', status: null, pending: false };
  const activeCount = envs.filter((e) => e.registry?.status !== 'reaped' && e.status?.state !== 'reaped').length;
  const restorePrimary = async () => {
    if (!window.confirm('Restore the primary env at lfx.pr-view.com?\n\nThe flipped apps restart — expect a ~30s blip. The displaced env stays reachable at its own hostname.')) return;
    try { await assignRoot('primary'); toast.success('Root restore requested'); load(); }
    catch (e) { toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `Root restore failed: ${e?.message ?? e}`); }
  };
  return (
    <section className="mb-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">Environments</span>
        <Badge color="gray" variant="soft" size="1">lfx</Badge>
        <span className="text-[11px] text-[var(--gray-10)]">{activeCount}/{info.cap ?? 4} + primary</span>
        <span className="text-[11px] text-[var(--gray-11)]" title="Which environment serves the root domain (root-assignment)">
          lfx.pr-view.com → <span className="font-mono">{root.env === 'primary' ? 'primary' : root.env}</span>
          {root.env !== 'primary' && <span className="text-[var(--gray-10)]"> · primary at lfx--main.pr-view.com</span>}
        </span>
        {root.pending && <Badge color="blue" variant="soft" size="1">root flip in progress</Badge>}
        {!root.pending && root.status?.state === 'error' && (
          <span className="text-[11px] text-red-600 dark:text-red-400 break-words" title={root.status?.detail}>
            root assignment failed: {root.status?.detail}
          </span>
        )}
        {root.env !== 'primary' && !root.pending && (
          <Button variant="soft" size="xs" onClick={restorePrimary}>Restore primary at root</Button>
        )}
      </div>
      {/* Behaviour signals from the Clarity session replay the routing layer
          injects into every env page. Self-contained and self-fetching, and it
          renders nothing when the export feed is unconfigured. */}
      <ClaritySignals />
      {/* Primary slot — pinned, never expires, its own agent + controls. */}
      <TestEnvOverviewPanel profile="lfx" projects={projects} />
      {envs.map((e) => <EnvCard key={e.label} entry={e} now={now} onAction={load} root={root} />)}
      <NewEnvForm onRequested={load} disabled={false} />
      {/* The log explorer keeps its own filter/poll state in the URL; `tick` is
          not threaded in on purpose — a registry poll should not reset the
          reader's scroll position or drop their live-tail highlight. */}
      <EnvLogExplorer envLabels={envs.map((e) => e.label)} now={now} />
    </section>
  );
}
