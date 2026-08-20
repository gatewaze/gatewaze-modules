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
import React, { useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { toast } from 'sonner';
import { BeakerIcon, ArrowTopRightOnSquareIcon, TrashIcon, RocketLaunchIcon } from '@heroicons/react/24/outline';
import {
  TEST_ENV_ACTIVE, STEPS, stepPct, normUrls, splitLiveDetail,
  useTestEnvStatus, teardownTestEnv,
} from './testEnv';
import TestEnvSetBuilder from './TestEnvSetBuilder';

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
  if (!info?.available) return null;

  const st = info.status;
  const detail = splitLiveDetail(st?.detail);
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
    <div className={`${className} rounded-md border border-[var(--gray-6)] px-3 py-2`}>
      <div className="flex items-center gap-2 flex-wrap">
        <BeakerIcon className="size-4 shrink-0" />
        <span className="text-sm font-medium">Test environment</span>
        <Badge color="gray" variant="soft" size="1">{profile}</Badge>
        <Badge color={ready ? 'green' : st?.state === 'error' ? 'red' : tornDown ? 'gray' : 'blue'} variant="soft" size="1">
          {info.pending && !TEST_ENV_ACTIVE.has(st?.state) ? 'queued' : (st?.state ?? 'torn-down')}
        </Badge>
        {st?.state !== 'error' && <span className="text-xs text-[var(--gray-11)] truncate">{detail.main}</span>}
        <span className="ml-auto flex items-center gap-2">
          {ready && (
            <Button variant="solid" color="green" size="xs" onClick={launch}>
              <RocketLaunchIcon className="size-3.5 mr-1" />Launch
            </Button>
          )}
          {ready && launchUrls.filter((u) => u.note).map((u) => (
            <span key={u.url} className="text-[11px] text-[var(--gray-10)]">{u.note}</span>
          ))}
          {ready && urls.filter((u) => !u.launch).map((u) => (
            <span key={u.url} className="inline-flex items-center gap-1">
              <a href={u.url} target="_blank" rel="noreferrer" className="text-xs text-blue-500 inline-flex items-center gap-0.5">
                {u.label} <ArrowTopRightOnSquareIcon className="size-3" />
              </a>
              {u.note && <span className="text-[11px] text-[var(--gray-10)]">{u.note}</span>}
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
        <div className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          {st.detail || 'The last test-env operation failed.'}
        </div>
      )}
      {st?.state !== 'error' && detail.live && (
        // Live-mode tracking line ("live: tracking repo@sha+#PR …, refreshed
        // <time>" — or the refresh-conflict/in-progress variants). Never
        // truncated: the sha+PR list is the point.
        <div className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-400 break-words">
          {detail.live}
        </div>
      )}
      {(active || info.pending) && (
        <div className="mt-2">
          <div className="h-1.5 rounded-full bg-[var(--gray-4)] overflow-hidden">
            <div className="h-full rounded-full bg-blue-500 transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--gray-10)]">
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
