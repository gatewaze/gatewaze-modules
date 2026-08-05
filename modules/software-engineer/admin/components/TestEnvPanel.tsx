// @ts-nocheck
/**
 * PR test environment panel (run view). Deployment-optional — renders only
 * where the operator wired a /staging-control channel (the staging box; see
 * api/admin-routes.ts test-env routes). Lets a super admin deploy this run's
 * PR set (plus any related PRs from other repos) into the single `aaif-test`
 * environment alongside staging: own DB (cloned from staging at deploy time),
 * own hostnames, no se-runner. One slot — deploying replaces the previous
 * test env; teardown frees it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Badge, Button } from '@/components/ui';
import { toast } from 'sonner';
import { BeakerIcon, ArrowTopRightOnSquareIcon, TrashIcon, PlusIcon } from '@heroicons/react/24/outline';

const API = '/api/modules/software-engineer/admin';
const DEPLOYABLE = ['gatewaze', 'gatewaze-modules', 'lf-gatewaze-modules'];
const ACTIVE = new Set(['preparing-worktrees', 'cloning-db', 'cloning-storage', 'building', 'starting', 'tearing-down']);

async function api(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    ...init, credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

export default function TestEnvPanel({ prs }: { prs: any[] }) {
  const runPrs = (prs ?? []).filter(
    (p) => p.repo_owner === 'gatewaze' && DEPLOYABLE.includes(p.repo_name) && p.pr_number,
  );
  const [info, setInfo] = useState<any>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>(
    () => Object.fromEntries(runPrs.map((p) => [`${p.repo_name}#${p.pr_number}`, true])),
  );
  const [extra, setExtra] = useState<{ repo: string; number: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api('/test-env/status').then(setInfo).catch(() => setInfo(null));
  }, []);
  const active = !!info && (info.pending || ACTIVE.has(info.status?.state));
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [active, load]);

  if (!info?.available) return null;

  const deploySet = () => {
    const set: { repo: string; number: number }[] = [];
    for (const p of runPrs) {
      if (selected[`${p.repo_name}#${p.pr_number}`] && !set.some((x) => x.repo === p.repo_name)) {
        set.push({ repo: p.repo_name, number: p.pr_number });
      }
    }
    for (const e of extra) {
      const n = Number(e.number);
      if (e.repo && Number.isInteger(n) && n > 0 && !set.some((x) => x.repo === e.repo)) {
        set.push({ repo: e.repo, number: n });
      }
    }
    return set;
  };

  const deploy = async () => {
    setBusy(true);
    try {
      await api('/test-env/deploy', { method: 'POST', body: JSON.stringify({ prs: deploySet() }) });
      toast.success('Test environment deploy requested');
      load();
    } catch (e: any) {
      toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `Deploy failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };
  const teardown = async () => {
    if (!window.confirm('Tear down the test environment?')) return;
    setBusy(true);
    try { await api('/test-env/teardown', { method: 'POST' }); toast.success('Teardown requested'); load(); }
    catch (e: any) { toast.error(`Teardown failed: ${e?.message ?? e}`); }
    finally { setBusy(false); }
  };

  const st = info.status;
  const ready = st?.state === 'ready';
  return (
    <div className="mb-3 rounded-md border border-[var(--gray-6)] px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <BeakerIcon className="size-4 shrink-0" />
        <span className="text-sm font-medium">Test environment</span>
        {st && (
          <Badge color={ready ? 'green' : st.state === 'error' ? 'red' : st.state === 'torn-down' ? 'gray' : 'blue'} variant="soft" size="1">
            {info.pending && !ACTIVE.has(st.state) ? 'queued' : st.state}
          </Badge>
        )}
        <span className="text-xs text-[var(--gray-11)] truncate">{st?.detail}</span>
        <span className="ml-auto flex items-center gap-2">
          {ready && (st?.urls ?? []).map((u: string) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="text-xs text-blue-500 inline-flex items-center gap-0.5">
              {u.replace('https://', '').split('.')[0]} <ArrowTopRightOnSquareIcon className="size-3" />
            </a>
          ))}
          {(ready || st?.state === 'error') && (
            <Button variant="soft" color="red" size="xs" onClick={teardown} disabled={busy || active}>
              <TrashIcon className="size-3.5 mr-1" />Tear down
            </Button>
          )}
        </span>
      </div>
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
