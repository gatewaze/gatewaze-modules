// @ts-nocheck
/**
 * Shared client for the PR test environments (run-view panel, Overview strip,
 * PR-board deploy buttons). Non-component module so fast refresh stays happy.
 * The envs are deployment-optional — consumers hide when status reports
 * available:false. Two PROFILES (gatewaze + lfx), each a separate env slot
 * with its own control channel and repo allowlist mirroring the server's.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const API = '/api/modules/software-engineer/admin';
export type TestEnvProfile = 'gatewaze' | 'lfx';
// Per-profile deployable repo lists — mirror the server + host-agent allowlists.
export const DEPLOYABLE: Record<TestEnvProfile, string[]> = {
  gatewaze: ['gatewaze', 'gatewaze-modules', 'lf-gatewaze-modules'],
  lfx: ['lfx-self-serve', 'lfx-v2-helm', 'lfx-v2-email-service', 'lfx-v2-campaign-service', 'lfx-v2-mailing-list-service', 'lfx-v2-newsletter-service', 'lfx-v2-committee-service'],
};
export const TEST_ENV_ACTIVE = new Set([
  'preparing-worktrees', 'cloning-db', 'cloning-storage', 'building', 'starting', 'tearing-down',
  // lfx-profile cycle states (same busy semantics)
  'deploying-helm', 'building-services', 'building-app', 'starting-app',
]);
/** Which env profile serves a project's PRs — null hides every test-env surface. */
export function testEnvProfile(projectName?: string): TestEnvProfile | null {
  if (!projectName) return null;
  if (projectName === 'Gatewaze') return 'gatewaze';
  if (/lfx/i.test(projectName)) return 'lfx';
  return null;
}

// Deploy-cycle progress models, per profile. Percentages hand-weighted by
// observed step duration (building dominates); tearing-down only appears when
// replacing.
export const STEPS: Record<TestEnvProfile, { state: string; label: string; pct: number }[]> = {
  gatewaze: [
    { state: 'queued', label: 'Queued', pct: 3 },
    { state: 'tearing-down', label: 'Replacing previous env', pct: 6 },
    { state: 'preparing-worktrees', label: 'Checking out PRs', pct: 12 },
    { state: 'cloning-db', label: 'Cloning database', pct: 30 },
    { state: 'cloning-storage', label: 'Cloning storage', pct: 42 },
    { state: 'building', label: 'Building images', pct: 70 },
    { state: 'starting', label: 'Starting services', pct: 90 },
    { state: 'ready', label: 'Live', pct: 100 },
  ],
  lfx: [
    { state: 'queued', label: 'Queued', pct: 3 },
    { state: 'tearing-down', label: 'Replacing previous env', pct: 6 },
    { state: 'preparing-worktrees', label: 'Checking out PRs', pct: 12 },
    { state: 'deploying-helm', label: 'Deploying helm', pct: 28 },
    { state: 'building-services', label: 'Building services', pct: 55 },
    { state: 'building-app', label: 'Building app', pct: 75 },
    { state: 'starting-app', label: 'Starting app', pct: 88 },
    { state: 'starting', label: 'Starting services', pct: 95 },
    { state: 'ready', label: 'Live', pct: 100 },
  ],
};
export const stepPct = (profile: TestEnvProfile, state?: string, pending?: boolean) => {
  if (!state || state === 'torn-down' || state === 'error') return pending ? 3 : 0;
  return STEPS[profile].find((s) => s.state === state)?.pct ?? 0;
};
// Agent emits [{label,url,launch,note?}]; tolerate legacy bare strings.
export const normUrls = (urls: any): { label: string; url: string; launch: boolean; note?: string }[] =>
  (urls ?? []).map((u: any) => typeof u === 'string'
    ? { label: u.replace('https://', '').split('.')[0], url: u, launch: true }
    : { label: u.label, url: u.url, launch: !!u.launch, ...(u.note ? { note: String(u.note) } : {}) });

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

// prs is an ORDERED list and may repeat a repo — the host merges same-repo PRs
// onto main locally in this exact order (merge-queue semantics).
export const deployTestEnv = (profile: TestEnvProfile, prs: { repo: string; number: number }[]) =>
  testEnvApi('/test-env/deploy', { method: 'POST', body: JSON.stringify({ profile, prs }) });
export const teardownTestEnv = (profile: TestEnvProfile) =>
  testEnvApi('/test-env/teardown', { method: 'POST', body: JSON.stringify({ profile }) });
/** Cross-repo related PRs (same head branch) for a deployable PR. */
export const fetchRelated = (profile: TestEnvProfile, projectId: string, repo: string, number: number) =>
  testEnvApi(`/test-env/related?${new URLSearchParams({ profile, project_id: projectId, repo, number: String(number) })}`);

/** Poll-while-active status hook shared by every test-env surface. */
export function useTestEnvStatus(profile: TestEnvProfile = 'gatewaze') {
  const [info, setInfo] = useState<any>(null);
  const load = useCallback(() => {
    testEnvApi(`/test-env/status?${new URLSearchParams({ profile })}`).then(setInfo).catch(() => setInfo(null));
  }, [profile]);
  const active = !!info && (info.pending || TEST_ENV_ACTIVE.has(info.status?.state));
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [active, load]);
  return { info, load, active };
}
