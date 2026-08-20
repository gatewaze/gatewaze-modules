// @ts-nocheck
/**
 * PR test environment panel (run view). Deployment-optional — renders only
 * where the operator wired a /staging-control channel AND the run's project
 * maps to an env profile (testEnvProfile: Gatewaze → gatewaze, LFX → lfx).
 * Run PRs pre-select (PR-number ascending); cross-repo related PRs (same head
 * branch, via /test-env/related) auto-populate pre-checked; a manual
 * "+ related PR" row remains for anything the heuristic misses.
 *
 * Selection is an ORDERED DEPLOY SET: checking a PR appends it; same-repo
 * entries can repeat and are merged onto main locally in the shown order
 * (merge-queue semantics on the host). One env slot per profile — deploying
 * replaces it.
 */
import React, { useEffect, useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { toast } from 'sonner';
import { BeakerIcon, ArrowTopRightOnSquareIcon, TrashIcon, PlusIcon, RocketLaunchIcon, ChevronUpIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import {
  DEPLOYABLE, TEST_ENV_ACTIVE, STEPS, stepPct, normUrls, testEnvProfile, splitLiveDetail,
  useTestEnvStatus, deployTestEnv, deployTestEnvMainline, teardownTestEnv, fetchRelated,
} from './testEnv';

export default function TestEnvPanel({ prs, projectId, projectName }: { prs: any[]; projectId?: string; projectName?: string }) {
  const profile = testEnvProfile(projectName);
  const deployable = profile ? DEPLOYABLE[profile] : [];
  const runPrs = (prs ?? []).filter(
    (p) => (profile !== 'gatewaze' || p.repo_owner === 'gatewaze') && deployable.includes(p.repo_name) && p.pr_number,
  );
  const { info, load, active } = useTestEnvStatus(profile ?? 'gatewaze');
  // Ordered deploy set — order is what gets sent, verbatim. Pre-check the
  // run's own PRs, PR-number ascending.
  const [deploySet, setDeploySet] = useState<{ repo: string; number: number }[]>(
    () => runPrs
      .map((p) => ({ repo: p.repo_name, number: p.pr_number }))
      .sort((a, b) => a.number - b.number),
  );
  const [related, setRelated] = useState<any[]>([]);   // auto-discovered, pre-checked
  const [extra, setExtra] = useState<{ repo: string; number: string }[]>([]);
  const [busy, setBusy] = useState(false);
  // Tier 1 live mode: the env re-merges and refreshes itself on every push.
  const [liveMode, setLiveMode] = useState(false);

  const inSet = (repo: string, number: number) => deploySet.some((x) => x.repo === repo && x.number === number);
  const toggle = (repo: string, number: number) =>
    setDeploySet((s) => inSet(repo, number) ? s.filter((x) => !(x.repo === repo && x.number === number)) : [...s, { repo, number }]);

  // Auto-discover cross-repo related PRs for each of the run's PRs.
  useEffect(() => {
    if (!profile || !projectId || runPrs.length === 0) return;
    let cancelled = false;
    (async () => {
      const found: any[] = [];
      for (const p of runPrs) {
        try {
          const r = await fetchRelated(profile, projectId, p.repo_name, p.pr_number);
          for (const rel of r?.related ?? []) {
            if (!found.some((f) => f.repo === rel.repo && f.number === rel.number)
              && !runPrs.some((rp) => rp.repo_name === rel.repo && rp.pr_number === rel.number)) {
              found.push(rel);
            }
          }
        } catch { /* lookup is best-effort */ }
      }
      if (!cancelled && found.length) {
        found.sort((a, b) => a.number - b.number);
        setRelated(found);
        setDeploySet((s) => [...s, ...found.filter((f) => !s.some((x) => x.repo === f.repo && x.number === f.number)).map((f) => ({ repo: f.repo, number: f.number }))]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps -- run PR set is stable per run

  if (!profile) return null;
  if (!info?.available) return null;

  // Move entry i up/down WITHIN its repo group (cross-repo order is cosmetic;
  // same-repo order is the merge order the host applies).
  const move = (i: number, dir: -1 | 1) => setDeploySet((s) => {
    const repo = s[i]?.repo;
    if (!repo) return s;
    let j = i + dir;
    while (j >= 0 && j < s.length && s[j].repo !== repo) j += dir;
    if (j < 0 || j >= s.length) return s;
    const next = [...s];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const deploy = async () => {
    setBusy(true);
    try {
      await deployTestEnv(profile, deploySet.map(({ repo, number }) => ({ repo, number })), liveMode);
      toast.success('Test environment deploy requested');
      load();
    } catch (e: any) {
      toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `Deploy failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };
  const deployMainline = async () => {
    if (!window.confirm('Deploy plain main (no PRs) to the test environment? This replaces the current env.')) return;
    setBusy(true);
    try {
      await deployTestEnvMainline(profile, liveMode);
      toast.success('Mainline deploy requested');
      load();
    } catch (e: any) {
      toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `Deploy failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };
  const teardown = async () => {
    if (!window.confirm('Tear down the test environment?')) return;
    setBusy(true);
    try { await teardownTestEnv(profile); toast.success('Teardown requested'); load(); }
    catch (e: any) { toast.error(`Teardown failed: ${e?.message ?? e}`); }
    finally { setBusy(false); }
  };

  const st = info.status;
  const detail = splitLiveDetail(st?.detail);
  const ready = st?.state === 'ready';
  const urls = normUrls(st?.urls);
  const launchUrls = urls.filter((u) => u.launch);
  const pct = stepPct(profile, info.pending && !TEST_ENV_ACTIVE.has(st?.state) ? 'queued' : st?.state, info.pending);
  const stepAgeSec = st?.updated_at ? Math.max(0, Math.round((Date.now() - new Date(st.updated_at).getTime()) / 1000)) : 0;
  const launch = () => { for (const u of launchUrls) window.open(u.url, '_blank', 'noopener'); };

  // Group the deploy set by repo (first-appearance order); intra-repo order is
  // the array's order — that is the order sent and the host's merge order.
  const groupRepos = [...new Set(deploySet.map((x) => x.repo))];
  const prUrlOf = (repo: string, number: number) =>
    runPrs.find((p) => p.repo_name === repo && p.pr_number === number)?.pr_url
    ?? related.find((r) => r.repo === repo && r.number === number)?.url ?? null;

  return (
    <div className="mb-3 rounded-md border border-[var(--gray-6)] px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <BeakerIcon className="size-4 shrink-0" />
        <span className="text-sm font-medium">Test environment</span>
        <Badge color="gray" variant="soft" size="1">{profile}</Badge>
        {st && (
          <Badge color={ready ? 'green' : st.state === 'error' ? 'red' : st.state === 'torn-down' ? 'gray' : 'blue'} variant="soft" size="1">
            {info.pending && !TEST_ENV_ACTIVE.has(st.state) ? 'queued' : st.state}
          </Badge>
        )}
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
      <div className="mt-2 flex items-center gap-3 flex-wrap text-xs">
        {runPrs.length === 0 && <span className="text-[var(--gray-10)]">No deployable PRs on this run yet — add one below to deploy.</span>}
        {runPrs.map((p) => {
          const k = `${p.repo_name}#${p.pr_number}`;
          return (
            <label key={k} className="inline-flex items-center gap-1.5">
              <input type="checkbox" className="size-3.5" checked={inSet(p.repo_name, p.pr_number)}
                onChange={() => toggle(p.repo_name, p.pr_number)} />
              <span>{p.repo_name} <a href={p.pr_url} target="_blank" rel="noreferrer" className="text-blue-500">#{p.pr_number}</a></span>
            </label>
          );
        })}
        {related.map((r) => {
          const k = `${r.repo}#${r.number}`;
          return (
            <label key={k} className="inline-flex items-center gap-1.5" title={`Same head branch (${r.branch}) — auto-detected`}>
              <input type="checkbox" className="size-3.5" checked={inSet(r.repo, r.number)}
                onChange={() => toggle(r.repo, r.number)} />
              <span>{r.repo} <a href={r.url} target="_blank" rel="noreferrer" className="text-blue-500">#{r.number}</a>
                <Badge color="purple" variant="soft" size="1" className="ml-1">related</Badge></span>
            </label>
          );
        })}
        {extra.map((e, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <select value={e.repo} onChange={(ev) => setExtra((x) => x.map((y, j) => j === i ? { ...y, repo: ev.target.value } : y))} className="rounded border px-1 py-0.5 text-xs">
              {deployable.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input value={e.number} placeholder="PR#" onChange={(ev) => setExtra((x) => x.map((y, j) => j === i ? { ...y, number: ev.target.value.replace(/\D/g, '') } : y))} className="w-14 rounded border px-1 py-0.5 text-xs" />
            <Button variant="ghost" size="xs" disabled={!Number.isInteger(Number(e.number)) || Number(e.number) < 1 || inSet(e.repo, Number(e.number))}
              onClick={() => {
                const n = Number(e.number);
                if (!Number.isInteger(n) || n < 1 || inSet(e.repo, n)) return;
                setDeploySet((s) => [...s, { repo: e.repo, number: n }]);
                setExtra((x) => x.filter((_, j) => j !== i));
              }}>Add</Button>
            <button onClick={() => setExtra((x) => x.filter((_, j) => j !== i))} className="text-[var(--gray-10)]">×</button>
          </span>
        ))}
        <Button variant="ghost" size="xs" onClick={() => setExtra((x) => [...x, { repo: deployable[0], number: '' }])}>
          <PlusIcon className="size-3.5 mr-0.5" />related PR
        </Button>
        <label className="inline-flex items-center gap-1.5 text-[var(--gray-11)]"
          title="env re-merges and refreshes automatically on every push">
          <input type="checkbox" className="size-3.5" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} />
          <span>Live — follow branch pushes</span>
        </label>
        <Button variant="soft" size="xs" onClick={deploy} disabled={busy || active || deploySet.length === 0}>
          <BeakerIcon className="size-3.5 mr-1" />{active ? 'Working…' : ready ? 'Redeploy' : 'Deploy to test env'}
        </Button>
        <Button variant="ghost" size="xs" onClick={deployMainline} disabled={busy || active}>
          Deploy main only (no PRs)
        </Button>
      </div>
      {deploySet.length > 0 && (
        <div className="mt-2 rounded border border-[var(--gray-5)] px-2 py-1.5">
          <div className="text-[11px] font-medium text-[var(--gray-11)]">Deploy set</div>
          <div className="mt-1 flex flex-col gap-1 text-xs">
            {groupRepos.map((repo) => {
              const groupCount = deploySet.filter((x) => x.repo === repo).length;
              return (
                <div key={repo} className="flex items-center gap-2 flex-wrap">
                  <span className="text-[var(--gray-10)] w-40 truncate">{repo}</span>
                  {deploySet.map((x, i) => x.repo === repo && (
                    <span key={`${x.repo}#${x.number}`} className="inline-flex items-center gap-0.5 rounded border border-[var(--gray-5)] px-1.5 py-0.5">
                      {prUrlOf(x.repo, x.number)
                        ? <a href={prUrlOf(x.repo, x.number)} target="_blank" rel="noreferrer" className="text-blue-500">#{x.number}</a>
                        : <span>#{x.number}</span>}
                      {groupCount > 1 && (
                        <>
                          <button title="Merge earlier" onClick={() => move(i, -1)} className="text-[var(--gray-10)] hover:text-[var(--gray-12)]"><ChevronUpIcon className="size-3" /></button>
                          <button title="Merge later" onClick={() => move(i, 1)} className="text-[var(--gray-10)] hover:text-[var(--gray-12)]"><ChevronDownIcon className="size-3" /></button>
                        </>
                      )}
                      <button title="Remove" onClick={() => toggle(x.repo, x.number)} className="text-[var(--gray-10)] hover:text-[var(--gray-12)]">×</button>
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="mt-1 text-[11px] text-[var(--gray-10)]">Same-repo PRs are merged onto main in this order, locally — nothing is pushed to GitHub.</div>
        </div>
      )}
    </div>
  );
}
