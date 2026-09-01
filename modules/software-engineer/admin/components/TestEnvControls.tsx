// @ts-nocheck
/**
 * Shared test-environment controls for one env profile — everything below the
 * caller's selection state: the status header (state badge, detail line,
 * Launch + extra URLs, teardown), the error box, the live-tracking line, the
 * deploy-cycle progress stepper, and the ordered PR-set builder
 * (<TestEnvSetBuilder>). Owns the status poll and hides itself on deployments
 * without this profile's control channel (available:false).
 *
 * Used by the run-view TestEnvPanel (which feeds its run-PR / related-PR
 * checkboxes through `children`) and by each per-profile Overview panel — the
 * panels keep only their own deploy-set selection and related-PR sourcing.
 */
import React, { useEffect, useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { toast } from 'sonner';
import { BeakerIcon, ArrowTopRightOnSquareIcon, BoltIcon, TrashIcon, RocketLaunchIcon } from '@heroicons/react/24/outline';
import {
  TEST_ENV_ACTIVE, STEPS, stepPct, normUrls,
  parseTestEnvDetail, relTime, testEnvPrUrl, testEnvCommitUrl,
  useTestEnvStatus, teardownTestEnv,
} from './testEnv';
import TestEnvSetBuilder from './TestEnvSetBuilder';

/** 10s re-render tick so the relative-time flags ("updated 20s ago") stay honest between polls. */
function useNow(ms = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export default function TestEnvControls({
  profile, deploySet, onChange, prUrlOf, addLabel, onAdded, className = 'mb-3', children,
}: {
  profile: 'gatewaze' | 'lfx';
  deploySet: { repo: string; number: number }[];
  onChange: (next: { repo: string; number: number }[]) => void;
  /** PR-page URL for a set entry, when the caller knows one (run PRs, related). */
  prUrlOf?: (repo: string, number: number) => string | null;
  /** Label for the builder's manual-add button ("related PR" in the run view). */
  addLabel?: string;
  /** A manual entry landed in the set — Overview hooks related-PR auto-detect here. */
  onAdded?: (repo: string, number: number) => void;
  /** Outer container classes (margin differs between the run view and Overview). */
  className?: string;
  /** Selection-row content; a function form receives { tornDown, ready, active }. */
  children?: React.ReactNode | ((ctx: { tornDown: boolean; ready: boolean; active: boolean }) => React.ReactNode);
}) {
  const { info, load, active } = useTestEnvStatus(profile);
  const [busy, setBusy] = useState(false);   // teardown in flight
  const now = useNow();                      // 10s ticker for the relative-time flags
  if (!info?.available) return null;

  const st = info.status;
  const detail = parseTestEnvDetail(st?.detail);
  // "updated" = the status file's last write, whichever path wrote it (state
  // change, live refresh, or the watcher heartbeat — the heartbeat rewrites
  // updated_at too, so the freshest of the two is what "updated" means).
  const updatedMs = Math.max(
    st?.updated_at ? Date.parse(st.updated_at) || 0 : 0,
    detail.checkedAt ? Date.parse(detail.checkedAt) || 0 : 0,
  );
  const updatedRel = updatedMs > 0 ? relTime(new Date(updatedMs).toISOString(), now) : null;
  const refreshedRel = relTime(detail.refreshedAt, now);
  const checkedRel = relTime(detail.checkedAt, now);
  const ready = st?.state === 'ready';
  const tornDown = !st || st.state === 'torn-down';
  const urls = normUrls(st?.urls);
  const launchUrls = urls.filter((u) => u.launch);
  const pct = stepPct(profile, info.pending && !TEST_ENV_ACTIVE.has(st?.state) ? 'queued' : st?.state, info.pending);
  const stepAgeSec = st?.updated_at ? Math.max(0, Math.round((Date.now() - new Date(st.updated_at).getTime()) / 1000)) : 0;
  const launch = () => { for (const u of launchUrls) window.open(u.url, '_blank', 'noopener'); };

  const teardown = async () => {
    if (!window.confirm('Tear down the test environment?')) return;
    setBusy(true);
    try { await teardownTestEnv(profile); toast.success('Teardown requested'); load(); }
    catch (e: any) { toast.error(`Teardown failed: ${e?.message ?? e}`); }
    finally { setBusy(false); }
  };

  return (
    <div className={`${className} rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100`}>
      <div className="flex items-center gap-2 flex-wrap">
        <BeakerIcon className="size-4 shrink-0" />
        <span className="text-sm font-medium">Test environment</span>
        <Badge color="gray" variant="soft" size="1">{profile}</Badge>
        <Badge color={ready ? 'green' : st?.state === 'error' ? 'red' : tornDown ? 'gray' : 'blue'} variant="soft" size="1">
          {info.pending && !TEST_ENV_ACTIVE.has(st?.state) ? 'queued' : (st?.state ?? 'torn-down')}
        </Badge>
        {detail.liveTracking && st?.state !== 'error' && (
          <Badge color="green" variant="soft" size="1" title="The host agent re-merges and refreshes this env automatically on every push">
            <BoltIcon className="size-3 mr-0.5" />Live — following branch pushes
          </Badge>
        )}
        {updatedRel && !tornDown && (
          <span className="text-[11px] text-neutral-400 whitespace-nowrap" title={st?.updated_at}>updated {updatedRel}</span>
        )}
        {st?.state !== 'error' && (
          // With a parsed deploy summary the repo rows below say what's
          // running; the header keeps only the leftover prose (e.g. the
          // admin/portal startup-builds note). Unparsed details show verbatim.
          <span className="text-xs text-neutral-300 truncate">
            {detail.repos.length > 0 ? (detail.note ?? '') : detail.main}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {ready && (
            <Button variant="solid" color="green" size="xs" onClick={launch}>
              <RocketLaunchIcon className="size-3.5 mr-1" />Launch
            </Button>
          )}
          {ready && launchUrls.filter((u) => u.note).map((u) => (
            <span key={u.url} className="text-[11px] text-neutral-400">{u.note}</span>
          ))}
          {ready && urls.filter((u) => !u.launch).map((u) => (
            <span key={u.url} className="inline-flex items-center gap-1">
              <a href={u.url} target="_blank" rel="noreferrer" className="text-xs text-blue-500 inline-flex items-center gap-0.5">
                {u.label} <ArrowTopRightOnSquareIcon className="size-3" />
              </a>
              {u.note && <span className="text-[11px] text-neutral-400">{u.note}</span>}
            </span>
          ))}
          {(ready || st?.state === 'error') && (
            <Button variant="soft" color="red" size="xs" onClick={teardown} disabled={busy || active}>
              <TrashIcon className="size-3.5 mr-1" />Tear down
            </Button>
          )}
        </span>
      </div>
      {st?.state === 'error' && (
        // The host names the conflicting PR in detail on a same-repo merge
        // conflict — surface it prominently, untruncated.
        <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
          {st.detail || 'The last test-env operation failed.'}
        </div>
      )}
      {st?.state !== 'error' && detail.repos.length > 0 && (
        // Structured deploy summary — exactly what's running, at a glance:
        // one row per repo with the base sha, the merged PRs (linked to
        // GitHub), and the resolved PR-head shas when live tracking reports
        // them. Freshness flags separate "refreshed" (last actual change)
        // from "checked" (the watcher heartbeat proving the tracker is alive).
        <div className="mt-2 rounded border border-neutral-700 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-neutral-400">
            <span className="font-medium text-neutral-300">
              Running now{detail.mainline ? ' — mainline (origin/main)' : ''}
            </span>
            {(refreshedRel || checkedRel) && (
              <span className="whitespace-nowrap">
                {refreshedRel && <span title={`Last change landed: ${detail.refreshedAt}`}>refreshed {refreshedRel}</span>}
                {refreshedRel && checkedRel && ' · '}
                {checkedRel && <span title={`Watcher heartbeat: ${detail.checkedAt}`}>checked {checkedRel}</span>}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-col gap-1 text-xs">
            {detail.repos.map((r) => (
              <div key={r.repo} className="flex items-center gap-2 flex-wrap">
                <span className="w-56 truncate text-neutral-300">{r.repo}</span>
                <a href={testEnvCommitUrl(profile, r.repo, r.baseSha)} target="_blank" rel="noreferrer"
                  className="font-mono text-[11px] text-neutral-400 hover:text-neutral-100" title="Base: origin/main at deploy/refresh time">
                  main@{r.baseSha.slice(0, 7)}
                </a>
                {r.prs.map((pr, i) => (
                  <span key={`${pr.number}-${i}`} className="inline-flex items-center gap-1 rounded border border-neutral-700 px-1.5 py-0.5">
                    <a href={testEnvPrUrl(profile, r.repo, pr.number)} target="_blank" rel="noreferrer" className="text-blue-500">#{pr.number}</a>
                    {pr.headSha && (
                      <a href={testEnvCommitUrl(profile, r.repo, pr.headSha)} target="_blank" rel="noreferrer"
                        className="font-mono text-[11px] text-neutral-400 hover:text-neutral-100" title="Resolved PR head — the exact push this env is running">
                        @{pr.headSha.slice(0, 7)}
                      </a>
                    )}
                  </span>
                ))}
                {r.prs.length === 0 && <span className="text-[11px] text-neutral-400">no PRs — plain main</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {st?.state !== 'error' && detail.conflict && (
        // A live refresh hit a merge conflict — the env is frozen at its
        // previous state until the branch is fixed and pushed again.
        <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300 break-words">
          Live refresh conflict: {detail.conflict}
        </div>
      )}
      {st?.state !== 'error' && detail.live && !detail.conflict
        && !(detail.liveTracking && detail.repos.length > 0) && (
        // Live-mode segment not covered by the structured display above (the
        // "Live refresh in progress …" variant, or a tracking list the parser
        // didn't recognise). Never truncated: the sha+PR list is the point.
        <div className="mt-1 text-[11px] text-emerald-400 break-words">
          {detail.live}
        </div>
      )}
      {(active || info.pending) && (
        <div className="mt-2">
          <div className="h-1.5 rounded-full bg-neutral-700 overflow-hidden">
            <div className="h-full rounded-full bg-blue-500 transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-neutral-400">
            <span>
              {STEPS[profile].filter((s) => !['queued', 'tearing-down', 'ready'].includes(s.state)).map((s, i, arr) => (
                <span key={s.state}>
                  <span className={s.state === st?.state ? 'text-blue-500 font-medium' : ''}>{s.label}</span>
                  {i < arr.length - 1 ? ' → ' : ''}
                </span>
              ))}
            </span>
            <span>{pct}%{stepAgeSec > 5 ? ` · ${stepAgeSec}s in this step` : ''}</span>
          </div>
        </div>
      )}
      <TestEnvSetBuilder
        profile={profile}
        deploySet={deploySet}
        onChange={onChange}
        prUrlOf={prUrlOf}
        active={active}
        ready={ready}
        tornDown={tornDown}
        disabled={busy}
        onRequested={load}
        onAdded={onAdded}
        {...(addLabel ? { addLabel } : {})}
      >
        {typeof children === 'function' ? children({ tornDown, ready, active }) : children}
      </TestEnvSetBuilder>
    </div>
  );
}
