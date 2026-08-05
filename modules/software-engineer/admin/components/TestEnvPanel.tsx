// @ts-nocheck
/**
 * PR test environment panel (run view). Deployment-optional — renders only
 * where the operator wired a /staging-control channel AND the run belongs to
 * the profile the env serves (Gatewaze until per-project profiles exist).
 * Run PRs pre-select; cross-repo related PRs (same head branch, via
 * /test-env/related) auto-populate pre-checked; a manual "+ related PR" row
 * remains for anything the heuristic misses. One env slot — deploying
 * replaces it.
 */
import React, { useEffect, useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { toast } from 'sonner';
import { BeakerIcon, ArrowTopRightOnSquareIcon, TrashIcon, PlusIcon, RocketLaunchIcon } from '@heroicons/react/24/outline';
import {
  DEPLOYABLE, TEST_ENV_ACTIVE, TEST_ENV_PROJECT, STEPS, stepPct, normUrls,
  useTestEnvStatus, deployTestEnv, teardownTestEnv, fetchRelated,
} from './testEnv';

export default function TestEnvPanel({ prs, projectId, projectName }: { prs: any[]; projectId?: string; projectName?: string }) {
  const runPrs = (prs ?? []).filter(
    (p) => p.repo_owner === 'gatewaze' && DEPLOYABLE.includes(p.repo_name) && p.pr_number,
  );
  const { info, load, active } = useTestEnvStatus();
  const [selected, setSelected] = useState<Record<string, boolean>>(
    () => Object.fromEntries(runPrs.map((p) => [`${p.repo_name}#${p.pr_number}`, true])),
  );
  const [related, setRelated] = useState<any[]>([]);   // auto-discovered, pre-checked
  const [extra, setExtra] = useState<{ repo: string; number: string }[]>([]);
  const [busy, setBusy] = useState(false);

  // Auto-discover cross-repo related PRs for each of the run's PRs.
  useEffect(() => {
    if (!projectId || runPrs.length === 0) return;
    let cancelled = false;
    (async () => {
      const found: any[] = [];
      for (const p of runPrs) {
        try {
          const r = await fetchRelated(projectId, p.repo_name, p.pr_number);
          for (const rel of r?.related ?? []) {
            if (!found.some((f) => f.repo === rel.repo && f.number === rel.number)
              && !runPrs.some((rp) => rp.repo_name === rel.repo && rp.pr_number === rel.number)) {
              found.push(rel);
            }
          }
        } catch { /* lookup is best-effort */ }
      }
      if (!cancelled && found.length) {
        setRelated(found);
        setSelected((s) => ({ ...s, ...Object.fromEntries(found.map((f) => [`${f.repo}#${f.number}`, true])) }));
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps -- run PR set is stable per run

  if (projectName && projectName !== TEST_ENV_PROJECT) return null;
  if (!info?.available) return null;

  const deploySet = () => {
    const set: { repo: string; number: number }[] = [];
    const consider = [
      ...runPrs.map((p) => ({ repo: p.repo_name, number: p.pr_number })),
      ...related.map((r) => ({ repo: r.repo, number: r.number })),
    ];
    for (const c of consider) {
      if (selected[`${c.repo}#${c.number}`] && !set.some((x) => x.repo === c.repo)) set.push(c);
    }
    for (const e of extra) {
      const n = Number(e.number);
      if (e.repo && Number.isInteger(n) && n > 0 && !set.some((x) => x.repo === e.repo)) set.push({ repo: e.repo, number: n });
    }
    return set;
  };

  const deploy = async () => {
    setBusy(true);
    try {
      await deployTestEnv(deploySet());
      toast.success('Test environment deploy requested');
      load();
    } catch (e: any) {
      toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `Deploy failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };
  const teardown = async () => {
    if (!window.confirm('Tear down the test environment?')) return;
    setBusy(true);
    try { await teardownTestEnv(); toast.success('Teardown requested'); load(); }
    catch (e: any) { toast.error(`Teardown failed: ${e?.message ?? e}`); }
    finally { setBusy(false); }
  };

  const st = info.status;
  const ready = st?.state === 'ready';
  const urls = normUrls(st?.urls);
  const launchUrls = urls.filter((u) => u.launch);
  const pct = stepPct(info.pending && !TEST_ENV_ACTIVE.has(st?.state) ? 'queued' : st?.state, info.pending);
  const stepAgeSec = st?.updated_at ? Math.max(0, Math.round((Date.now() - new Date(st.updated_at).getTime()) / 1000)) : 0;
  const launch = () => { for (const u of launchUrls) window.open(u.url, '_blank', 'noopener'); };

  return (
    <div className="mb-3 rounded-md border border-[var(--gray-6)] px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <BeakerIcon className="size-4 shrink-0" />
        <span className="text-sm font-medium">Test environment</span>
        {st && (
          <Badge color={ready ? 'green' : st.state === 'error' ? 'red' : st.state === 'torn-down' ? 'gray' : 'blue'} variant="soft" size="1">
            {info.pending && !TEST_ENV_ACTIVE.has(st.state) ? 'queued' : st.state}
          </Badge>
        )}
        <span className="text-xs text-[var(--gray-11)] truncate">{st?.detail}</span>
        <span className="ml-auto flex items-center gap-2">
          {ready && (
            <Button variant="solid" color="green" size="xs" onClick={launch}>
              <RocketLaunchIcon className="size-3.5 mr-1" />Launch
            </Button>
          )}
          {ready && urls.filter((u) => !u.launch).map((u) => (
            <a key={u.url} href={u.url} target="_blank" rel="noreferrer" className="text-xs text-blue-500 inline-flex items-center gap-0.5">
              {u.label} <ArrowTopRightOnSquareIcon className="size-3" />
            </a>
          ))}
          {(ready || st?.state === 'error') && (
            <Button variant="soft" color="red" size="xs" onClick={teardown} disabled={busy || active}>
              <TrashIcon className="size-3.5 mr-1" />Tear down
            </Button>
          )}
        </span>
      </div>
      {(active || info.pending) && (
        <div className="mt-2">
          <div className="h-1.5 rounded-full bg-[var(--gray-4)] overflow-hidden">
            <div className="h-full rounded-full bg-blue-500 transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--gray-10)]">
            <span>
              {STEPS.filter((s) => !['queued', 'tearing-down', 'ready'].includes(s.state)).map((s, i, arr) => (
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
        {runPrs.length === 0 && <span className="text-[var(--gray-10)]">No deployable PRs on this run yet — deploy runs everything at main.</span>}
        {runPrs.map((p) => {
          const k = `${p.repo_name}#${p.pr_number}`;
          return (
            <label key={k} className="inline-flex items-center gap-1.5">
              <input type="checkbox" className="size-3.5" checked={!!selected[k]}
                onChange={() => setSelected((s) => ({ ...s, [k]: !s[k] }))} />
              <span>{p.repo_name} <a href={p.pr_url} target="_blank" rel="noreferrer" className="text-blue-500">#{p.pr_number}</a></span>
            </label>
          );
        })}
        {related.map((r) => {
          const k = `${r.repo}#${r.number}`;
          return (
            <label key={k} className="inline-flex items-center gap-1.5" title={`Same head branch (${r.branch}) — auto-detected`}>
              <input type="checkbox" className="size-3.5" checked={!!selected[k]}
                onChange={() => setSelected((s) => ({ ...s, [k]: !s[k] }))} />
              <span>{r.repo} <a href={r.url} target="_blank" rel="noreferrer" className="text-blue-500">#{r.number}</a>
                <Badge color="purple" variant="soft" size="1" className="ml-1">related</Badge></span>
            </label>
          );
        })}
        {extra.map((e, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <select value={e.repo} onChange={(ev) => setExtra((x) => x.map((y, j) => j === i ? { ...y, repo: ev.target.value } : y))} className="rounded border px-1 py-0.5 text-xs">
              {DEPLOYABLE.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input value={e.number} placeholder="PR#" onChange={(ev) => setExtra((x) => x.map((y, j) => j === i ? { ...y, number: ev.target.value.replace(/\D/g, '') } : y))} className="w-14 rounded border px-1 py-0.5 text-xs" />
            <button onClick={() => setExtra((x) => x.filter((_, j) => j !== i))} className="text-[var(--gray-10)]">×</button>
          </span>
        ))}
        <Button variant="ghost" size="xs" onClick={() => setExtra((x) => [...x, { repo: 'gatewaze-modules', number: '' }])}>
          <PlusIcon className="size-3.5 mr-0.5" />related PR
        </Button>
        <Button variant="soft" size="xs" onClick={deploy} disabled={busy || active}>
          <BeakerIcon className="size-3.5 mr-1" />{active ? 'Working…' : ready ? 'Redeploy' : 'Deploy to test env'}
        </Button>
      </div>
    </div>
  );
}
