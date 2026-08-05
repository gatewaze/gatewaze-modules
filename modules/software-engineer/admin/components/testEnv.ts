// @ts-nocheck
/**
 * Shared client for the PR test environment (run-view panel, Overview strip,
 * PR-board deploy buttons). Non-component module so fast refresh stays happy.
 * The env itself is deployment-optional — consumers hide when status reports
 * available:false. Currently one profile (gatewaze); the repo enum mirrors
 * the server + host-agent allowlists.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const API = '/api/modules/software-engineer/admin';
export const DEPLOYABLE = ['gatewaze', 'gatewaze-modules', 'lf-gatewaze-modules'];
export const TEST_ENV_ACTIVE = new Set(['preparing-worktrees', 'cloning-db', 'cloning-storage', 'building', 'starting', 'tearing-down']);
// Profile gate until per-project environment profiles exist: only the
// Gatewaze project's PRs land on the deployable repos.
export const TEST_ENV_PROJECT = 'Gatewaze';

// Deploy-cycle progress model. Percentages hand-weighted by observed step
// duration (building dominates); tearing-down only appears when replacing.
export const STEPS: { state: string; label: string; pct: number }[] = [
  { state: 'queued', label: 'Queued', pct: 3 },
  { state: 'tearing-down', label: 'Replacing previous env', pct: 6 },
  { state: 'preparing-worktrees', label: 'Checking out PRs', pct: 12 },
  { state: 'cloning-db', label: 'Cloning database', pct: 30 },
  { state: 'cloning-storage', label: 'Cloning storage', pct: 42 },
  { state: 'building', label: 'Building images', pct: 70 },
  { state: 'starting', label: 'Starting services', pct: 90 },
  { state: 'ready', label: 'Live', pct: 100 },
];
export const stepPct = (state?: string, pending?: boolean) => {
  if (!state || state === 'torn-down' || state === 'error') return pending ? 3 : 0;
  return STEPS.find((s) => s.state === state)?.pct ?? 0;
};
// Agent emits [{label,url,launch}]; tolerate legacy bare strings.
export const normUrls = (urls: any): { label: string; url: string; launch: boolean }[] =>
  (urls ?? []).map((u: any) => typeof u === 'string'
    ? { label: u.replace('https://', '').split('.')[0], url: u, launch: true }
    : { label: u.label, url: u.url, launch: !!u.launch });

export async function testEnvApi(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    ...init, credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

export const deployTestEnv = (prs: { repo: string; number: number }[]) =>
  testEnvApi('/test-env/deploy', { method: 'POST', body: JSON.stringify({ prs }) });
export const teardownTestEnv = () => testEnvApi('/test-env/teardown', { method: 'POST' });
/** Cross-repo related PRs (same head branch) for a deployable PR. */
export const fetchRelated = (projectId: string, repo: string, number: number) =>
  testEnvApi(`/test-env/related?${new URLSearchParams({ project_id: projectId, repo, number: String(number) })}`);

/** Poll-while-active status hook shared by every test-env surface. */
export function useTestEnvStatus() {
  const [info, setInfo] = useState<any>(null);
  const load = useCallback(() => {
    testEnvApi('/test-env/status').then(setInfo).catch(() => setInfo(null));
  }, []);
  const active = !!info && (info.pending || TEST_ENV_ACTIVE.has(info.status?.state));
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [active, load]);
  return { info, load, active };
}
