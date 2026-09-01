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
import type { TestEnvProfile } from './testEnvSet';

const API = '/api/modules/software-engineer/admin';
// Deploy-set types + pure ordering helpers live in testEnvSet.ts (node-testable,
// no supabase/ui imports); re-exported here so consumers keep one import site.
export { testEnvProfile } from './testEnvSet';
export type { DeployEntry, TestEnvProfile } from './testEnvSet';
// Status-detail-line parsing + freshness helpers live in testEnvStatusLine.ts
// (node-testable, no supabase/ui imports); re-exported here likewise.
export {
  splitLiveDetail, parseTestEnvDetail, relTime, testEnvPrUrl, testEnvCommitUrl,
} from './testEnvStatusLine';
export type { ParsedDetail, ParsedRepo, ParsedPr } from './testEnvStatusLine';
// Per-profile deployable repo lists — mirror the server + host-agent allowlists.
export const DEPLOYABLE: Record<TestEnvProfile, string[]> = {
  gatewaze: ['gatewaze', 'gatewaze-modules', 'lf-gatewaze-modules'],
  lfx: ['lfx-self-serve', 'lfx-v2-helm', 'lfx-v2-email-service', 'lfx-v2-campaign-service', 'lfx-v2-mailing-list-service', 'lfx-v2-newsletter-service', 'lfx-v2-committee-service'],
};
export const TEST_ENV_ACTIVE = new Set([
  'preparing-worktrees', 'cloning-db', 'cloning-storage', 'building', 'starting', 'tearing-down',
  // lfx-profile cycle states (same busy semantics)
  'deploying-helm', 'building-services', 'building-app', 'starting-app',
  // lfx-profile "fresh" reseed sub-step (staging-lfx-env.sh do_fresh path) —
  // distinct from 'starting' (which is just the port-wait) so a fresh deploy
  // shows what it's actually doing instead of looking identical to the app
  // simply booting; 'ready' is only ever written after this returns 0.
  'seeding-data',
]);
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
    { state: 'seeding-data', label: 'Fresh data: reseeding mock data', pct: 97 },
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
// live=true (Tier 1 live mode): the host agent keeps tracking origin/main and
// the merged PR heads after the deploy, re-merging and refreshing the env
// automatically on every push. Strict boolean end to end.
// fresh=true: the host agent wipes the env's data stores and reruns the full
// seed after the deploy (lfx: newsletter DB schema drop + mockdata reseed).
// Strict boolean end to end, same contract as live. The lfx agent treats any
// deploy starting from a torn-down env as fresh regardless of the flag.
export const deployTestEnv = (profile: TestEnvProfile, prs: { repo: string; number: number }[], live = false, fresh = false) =>
  testEnvApi('/test-env/deploy', { method: 'POST', body: JSON.stringify({ profile, prs, live: live === true, fresh: fresh === true }) });
// Mainline deploy: plain origin/main with NO PRs. The server only accepts an
// empty prs list alongside the explicit mainline flag (accidental empty sets
// still 422), and the host agent deploys origin/main of every profile repo.
// live=true here tracks pushes to origin/main itself.
export const deployTestEnvMainline = (profile: TestEnvProfile, live = false, fresh = false) =>
  testEnvApi('/test-env/deploy', { method: 'POST', body: JSON.stringify({ profile, prs: [], mainline: true, live: live === true, fresh: fresh === true }) });
export const teardownTestEnv = (profile: TestEnvProfile) =>
  testEnvApi('/test-env/teardown', { method: 'POST', body: JSON.stringify({ profile }) });
/** Cross-repo related PRs (same head branch) for a deployable PR. */
export const fetchRelated = (profile: TestEnvProfile, projectId: string, repo: string, number: number) =>
  testEnvApi(`/test-env/related?${new URLSearchParams({ profile, project_id: projectId, repo, number: String(number) })}`);

// ── Hostname-keyed multi envs (lfx profile — spec §4.3 phase 2) ──────────────
// The label is ALWAYS computed server-side from the spec (canonical grammar
// encode); the client never invents one. Teardown/refresh take a label the
// server validated against the same grammar before any file path is built.
export const listEnvs = () => testEnvApi('/test-env/envs');
export const createEnv = (spec: ({ repo: string; pr: number } | { repo: string; branch: string })[], live: boolean, ttlHours?: number) =>
  testEnvApi('/test-env/envs', {
    method: 'POST',
    body: JSON.stringify({ spec, live: live === true, ...(ttlHours !== undefined ? { ttl_hours: ttlHours } : {}) }),
  });
export const teardownEnv = (label: string) =>
  testEnvApi(`/test-env/envs/${encodeURIComponent(label)}`, { method: 'DELETE' });
export const refreshEnv = (label: string) =>
  testEnvApi(`/test-env/envs/${encodeURIComponent(label)}/refresh`, { method: 'POST', body: '{}' });
/** Assign lfx.pr-view.com to an env ("primary" restores the mainline slot). */
export const assignRoot = (env: string) =>
  testEnvApi('/test-env/envs/root-assignment', { method: 'POST', body: JSON.stringify({ env }) });
/**
 * Log-explorer query. `env` and `kind` are comma-separated sets (env accepts
 * the literal "none" for the unattributed shared-Authelia events); `since`/
 * `until` are ISO instants; `before_ts`+`before_id` are the keyset cursor the
 * previous page returned as `next_cursor`. The server re-validates every one
 * of these — this builder is convenience, not the trust boundary.
 */
export interface EnvEventQuery {
  env?: string; kind?: string; q?: string;
  since?: string; until?: string;
  limit?: number; before_ts?: string; before_id?: number;
  summary?: boolean; buckets?: number;
}
const envEventQs = (opts: EnvEventQuery) => {
  const qs = new URLSearchParams();
  for (const k of ['env', 'kind', 'q', 'since', 'until', 'before_ts'] as const) {
    if (opts[k]) qs.set(k, String(opts[k]));
  }
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.before_id) qs.set('before_id', String(opts.before_id));
  if (opts.buckets) qs.set('buckets', String(opts.buckets));
  if (opts.summary) qs.set('summary', '1');
  return qs.toString();
};
export const fetchEnvEvents = (opts: EnvEventQuery = {}) => {
  const q = envEventQs(opts);
  return testEnvApi(`/test-env/env-events${q ? `?${q}` : ''}`);
};
export const fetchEnvEventSummary = (opts: EnvEventQuery = {}) =>
  fetchEnvEvents({ ...opts, summary: true });

/**
 * Polling status hook shared by every test-env surface. Cadence follows what
 * the panel is watching: 6s through a deploy cycle, 12s while ready in live
 * mode (so the watcher's "refreshed/checked" heartbeat rewrites surface
 * quickly — the requirement is ≤15s), 30s otherwise (deploys/teardowns from
 * another tab should still appear). Hidden tabs skip the fetch and refresh
 * immediately on becoming visible again.
 */
export function useTestEnvStatus(profile: TestEnvProfile = 'gatewaze') {
  const [info, setInfo] = useState<any>(null);
  const load = useCallback(() => {
    testEnvApi(`/test-env/status?${new URLSearchParams({ profile })}`).then(setInfo).catch(() => setInfo(null));
  }, [profile]);
  const active = !!info && (info.pending || TEST_ENV_ACTIVE.has(info.status?.state));
  const live = !!info && info.status?.state === 'ready'
    && /live: tracking|live refresh/i.test(String(info.status?.detail ?? ''));
  const interval = active ? 6000 : live ? 12000 : 30000;
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) load();
    }, interval);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [interval, load]);
  return { info, load, active, live };
}
