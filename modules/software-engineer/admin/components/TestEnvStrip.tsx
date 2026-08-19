// @ts-nocheck
/**
 * Compact test-environment status strip for the Overview page: what's
 * deployed (the agent's manifest detail names each repo@sha and PR), live
 * progress while a cycle runs, Launch on ready, teardown. Hides itself on
 * deployments without the control channel.
 */
import React from 'react';
import { Badge, Button } from '@/components/ui';
import { toast } from 'sonner';
import { BeakerIcon, ArrowTopRightOnSquareIcon, TrashIcon, RocketLaunchIcon } from '@heroicons/react/24/outline';
import { TEST_ENV_ACTIVE, stepPct, normUrls, useTestEnvStatus, teardownTestEnv } from './testEnv';

export default function TestEnvStrip({ profile = 'gatewaze' }: { profile?: 'gatewaze' | 'lfx' }) {
  const { info, load, active } = useTestEnvStatus(profile);
  if (!info?.available) return null;
  const st = info.status;
  if (!st || st.state === 'torn-down') return null;   // nothing deployed — stay out of the way
  const ready = st.state === 'ready';
  const urls = normUrls(st.urls);
  const launchUrls = urls.filter((u) => u.launch);
  const pct = stepPct(profile, info.pending && !TEST_ENV_ACTIVE.has(st.state) ? 'queued' : st.state, info.pending);
  const launch = () => { for (const u of launchUrls) window.open(u.url, '_blank', 'noopener'); };
  const teardown = async () => {
    if (!window.confirm('Tear down the test environment?')) return;
    try { await teardownTestEnv(profile); toast.success('Teardown requested'); load(); }
    catch (e: any) { toast.error(`Teardown failed: ${e?.message ?? e}`); }
  };
  return (
    <div className="mb-4 rounded-md border border-[var(--gray-6)] px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <BeakerIcon className="size-4 shrink-0" />
        <span className="text-sm font-medium">Test environment</span>
        <Badge color={ready ? 'green' : st.state === 'error' ? 'red' : 'blue'} variant="soft" size="1">
          {info.pending && !TEST_ENV_ACTIVE.has(st.state) ? 'queued' : st.state}
        </Badge>
        <span className="text-xs text-[var(--gray-11)] truncate">{st.detail}</span>
        <span className="ml-auto flex items-center gap-2">
          {ready && (
            <Button variant="solid" color="green" size="xs" onClick={launch}>
              <RocketLaunchIcon className="size-3.5 mr-1" />Launch
            </Button>
          )}
          {ready && urls.filter((u) => !u.launch).map((u) => (
            <span key={u.url} className="inline-flex items-center gap-1">
              <a href={u.url} target="_blank" rel="noreferrer" className="text-xs text-blue-500 inline-flex items-center gap-0.5">
                {u.label} <ArrowTopRightOnSquareIcon className="size-3" />
              </a>
              {u.note && <span className="text-[11px] text-[var(--gray-10)]">{u.note}</span>}
            </span>
          ))}
          {(ready || st.state === 'error') && (
            <Button variant="soft" color="red" size="xs" onClick={teardown} disabled={active}>
              <TrashIcon className="size-3.5 mr-1" />Tear down
            </Button>
          )}
        </span>
      </div>
      {(active || info.pending) && (
        <div className="mt-2 h-1.5 rounded-full bg-[var(--gray-4)] overflow-hidden">
          <div className="h-full rounded-full bg-blue-500 transition-all duration-700" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
