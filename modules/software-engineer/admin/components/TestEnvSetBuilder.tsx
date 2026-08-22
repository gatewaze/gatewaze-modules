// @ts-nocheck
/**
 * Ordered PR-set builder — the shared deploy controls for one test-env
 * profile. Used by the run-view TestEnvPanel (which renders its own run-PR /
 * related checkboxes and feeds this a controlled deploySet) and by each
 * per-profile Overview panel. Owns: the manual "+ PR" add rows (repo select +
 * number), the Live checkbox (Tier 1 live mode), the deploy / mainline-deploy
 * actions, and the grouped deploy-set display with same-repo reordering.
 *
 * The set is ORDERED: same-repo entries are merged onto origin/main locally in
 * the shown order (merge-queue semantics on the host); nothing is pushed.
 */
import React, { useState } from 'react';
import { Button } from '@/components/ui';
import { toast } from 'sonner';
import { BeakerIcon, PlusIcon, ChevronUpIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { DEPLOYABLE, deployTestEnv, deployTestEnvMainline } from './testEnv';
import { addEntry, groupRepos, inSet, moveWithinRepo, toggleEntry } from './testEnvSet';

export default function TestEnvSetBuilder({
  profile, deploySet, onChange, prUrlOf, active, ready, tornDown, disabled, onRequested, onAdded, addLabel = 'add PR', children,
}: {
  profile: 'gatewaze' | 'lfx';
  deploySet: { repo: string; number: number }[];
  onChange: (next: { repo: string; number: number }[]) => void;
  /** PR-page URL for an entry, when the caller knows one (run PRs, related). */
  prUrlOf?: (repo: string, number: number) => string | null;
  active?: boolean;
  ready?: boolean;
  /** No env deployed (drives the fresh-data default: torn-down → checked). */
  tornDown?: boolean;
  /** Extra parent-side lockout (e.g. a teardown in flight). */
  disabled?: boolean;
  /** Reload status after a deploy request was accepted. */
  onRequested?: () => void;
  /** A manual entry landed in the set — Overview hooks related-PR auto-detect here. */
  onAdded?: (repo: string, number: number) => void;
  /** Label for the manual-add button ("related PR" in the run view). */
  addLabel?: string;
  /** Rendered inside the selection row, before the builder's own controls. */
  children?: React.ReactNode;
}) {
  const deployable = DEPLOYABLE[profile];
  const [extra, setExtra] = useState<{ repo: string; number: string }[]>([]);
  // Tier 1 live mode: the env re-merges and refreshes itself on every push.
  const [liveMode, setLiveMode] = useState(false);
  // Fresh data (lfx profile): wipe the newsletter DB + rerun the full seed.
  // Until the user touches the checkbox it FOLLOWS the env state — checked
  // when torn-down (matching the host agent, which always runs fresh from
  // torn-down), unchecked when replacing a live env (keep its data). An
  // explicit click pins the choice for this panel's lifetime.
  const [freshChoice, setFreshChoice] = useState<boolean | null>(null);
  const freshMode = freshChoice ?? !!tornDown;
  // Only the lfx host agent implements fresh; the gatewaze env always clones
  // its data fresh at deploy, so the checkbox would be a no-op there.
  const showFresh = profile === 'lfx';
  const [busy, setBusy] = useState(false);
  const blocked = busy || !!active || !!disabled;

  const deploy = async () => {
    setBusy(true);
    try {
      await deployTestEnv(profile, deploySet.map(({ repo, number }) => ({ repo, number })), liveMode, showFresh && freshMode);
      toast.success('Test environment deploy requested');
      onRequested?.();
    } catch (e: any) {
      toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `Deploy failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };
  const deployMainline = async () => {
    if (!window.confirm('Deploy plain main (no PRs) to the test environment? This replaces the current env.')) return;
    setBusy(true);
    try {
      await deployTestEnvMainline(profile, liveMode, showFresh && freshMode);
      toast.success('Mainline deploy requested');
      onRequested?.();
    } catch (e: any) {
      toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `Deploy failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };

  const add = (repo: string, number: number) => {
    const next = addEntry(deploySet, repo, number);
    if (next === deploySet) return;
    onChange(next);
    onAdded?.(repo, number);
  };

  // Group the deploy set by repo (first-appearance order); intra-repo order is
  // the array's order — that is the order sent and the host's merge order.
  const repos = groupRepos(deploySet);

  return (
    <>
      <div className="mt-2 flex items-center gap-3 flex-wrap text-xs">
        {children}
        {extra.map((e, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <select value={e.repo} onChange={(ev) => setExtra((x) => x.map((y, j) => j === i ? { ...y, repo: ev.target.value } : y))} className="rounded border bg-neutral-800 border-neutral-700 text-neutral-100 px-1 py-0.5 text-xs">
              {deployable.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input value={e.number} placeholder="PR#" onChange={(ev) => setExtra((x) => x.map((y, j) => j === i ? { ...y, number: ev.target.value.replace(/\D/g, '') } : y))} className="w-14 rounded border bg-neutral-800 border-neutral-700 text-neutral-100 px-1 py-0.5 text-xs" />
            <Button variant="ghost" size="xs" disabled={!Number.isInteger(Number(e.number)) || Number(e.number) < 1 || inSet(deploySet, e.repo, Number(e.number))}
              onClick={() => {
                add(e.repo, Number(e.number));
                setExtra((x) => x.filter((_, j) => j !== i));
              }}>Add</Button>
            <button onClick={() => setExtra((x) => x.filter((_, j) => j !== i))} className="text-neutral-400">×</button>
          </span>
        ))}
        <Button variant="ghost" size="xs" onClick={() => setExtra((x) => [...x, { repo: deployable[0], number: '' }])}>
          <PlusIcon className="size-3.5 mr-0.5" />{addLabel}
        </Button>
        <label className="inline-flex items-center gap-1.5 text-neutral-300"
          title="env re-merges and refreshes automatically on every push">
          <input type="checkbox" className="size-3.5" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} />
          <span>Live — follow branch pushes</span>
        </label>
        {showFresh && (
          <label className="inline-flex items-center gap-1.5 text-neutral-300"
            title="Wipes: the newsletter database (dropped and recreated by the deployed branch's own schema), all mock platform data (projects, committees, groups, board meetings), and reseeds the staging playbooks (test-user access grants, newsletter groups, the AAIF foundation). Deploys from a torn-down env always run fresh; uncheck when replacing a live env to keep its data.">
            <input type="checkbox" className="size-3.5" checked={freshMode} onChange={(e) => setFreshChoice(e.target.checked)} />
            <span>Fresh data (wipe + reseed)</span>
          </label>
        )}
        <Button variant="soft" size="xs" onClick={deploy} disabled={blocked || deploySet.length === 0}>
          <BeakerIcon className="size-3.5 mr-1" />{active ? 'Working…' : ready ? 'Redeploy' : 'Deploy to test env'}
        </Button>
        <Button variant="ghost" size="xs" onClick={deployMainline} disabled={blocked}>
          Deploy main only (no PRs)
        </Button>
      </div>
      {deploySet.length > 0 && (
        <div className="mt-2 rounded border border-neutral-700 px-2 py-1.5">
          <div className="text-[11px] font-medium text-neutral-300">Deploy set</div>
          <div className="mt-1 flex flex-col gap-1 text-xs">
            {repos.map((repo) => {
              const groupCount = deploySet.filter((x) => x.repo === repo).length;
              return (
                <div key={repo} className="flex items-center gap-2 flex-wrap">
                  <span className="text-neutral-400 w-40 truncate">{repo}</span>
                  {deploySet.map((x, i) => x.repo === repo && (
                    <span key={`${x.repo}#${x.number}`} className="inline-flex items-center gap-0.5 rounded border border-neutral-700 px-1.5 py-0.5">
                      {prUrlOf?.(x.repo, x.number)
                        ? <a href={prUrlOf(x.repo, x.number)} target="_blank" rel="noreferrer" className="text-blue-500">#{x.number}</a>
                        : <span>#{x.number}</span>}
                      {groupCount > 1 && (
                        <>
                          <button title="Merge earlier" onClick={() => onChange(moveWithinRepo(deploySet, i, -1))} className="text-neutral-400 hover:text-neutral-100"><ChevronUpIcon className="size-3" /></button>
                          <button title="Merge later" onClick={() => onChange(moveWithinRepo(deploySet, i, 1))} className="text-neutral-400 hover:text-neutral-100"><ChevronDownIcon className="size-3" /></button>
                        </>
                      )}
                      <button title="Remove" onClick={() => onChange(toggleEntry(deploySet, x.repo, x.number))} className="text-neutral-400 hover:text-neutral-100">×</button>
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="mt-1 text-[11px] text-neutral-400">Same-repo PRs are merged onto main in this order, locally — nothing is pushed to GitHub.</div>
        </div>
      )}
    </>
  );
}
