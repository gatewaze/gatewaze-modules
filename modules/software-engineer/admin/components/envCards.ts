/**
 * Pure logic behind the Overview "Environments" section (hostname-keyed lfx
 * multi envs) — split from the component file so it unit-tests under
 * vitest's node environment (same reasoning as testEnvSet.ts /
 * testEnvStatusLine.ts). Everything here renders registry + status data the
 * host agent (staging-multienv.sh) writes; nothing calls the network.
 */

export type EnvSpecDisplayEntry = { repo: string; pr?: number; branch?: string; key: string };
export type EnvListEntry = {
  label: string;
  registry: Record<string, unknown> | null;
  status: { state?: string; detail?: string; urls?: unknown; updated_at?: string } | null;
  pending: boolean;
};

// Deploy-cycle states the multienv agent emits (lib-lfx-env.sh env_status
// call sites), with hand-weighted progress like testEnv.ts STEPS.
export const ENV_STEPS: { state: string; label: string; pct: number }[] = [
  { state: 'queued', label: 'Queued', pct: 3 },
  { state: 'preparing-worktrees', label: 'Checking out env set', pct: 15 },
  { state: 'building-services', label: 'Building services', pct: 45 },
  { state: 'deploying-routes', label: 'Wiring routes + auth', pct: 60 },
  { state: 'building-app', label: 'Building app', pct: 78 },
  { state: 'starting-app', label: 'Starting app', pct: 92 },
  { state: 'ready', label: 'Live', pct: 100 },
];
export const ENV_ACTIVE_STATES = new Set([
  'preparing-worktrees', 'building-services', 'deploying-routes', 'building-app', 'starting-app', 'tearing-down',
]);

export const envStepPct = (state?: string, pending?: boolean): number => {
  if (!state || state === 'torn-down' || state === 'error' || state === 'reaped') return pending ? 3 : 0;
  if (state === 'tearing-down') return 6;
  return ENV_STEPS.find((s) => s.state === state)?.pct ?? 0;
};

/** Badge model for an env card. Colours match the primary panel's semantics. */
export const envStateBadge = (state?: string, pending?: boolean): { label: string; color: 'green' | 'red' | 'gray' | 'blue' | 'amber' } => {
  if (pending && !ENV_ACTIVE_STATES.has(state ?? '')) return { label: 'queued', color: 'blue' };
  if (!state || state === 'torn-down') return { label: 'torn-down', color: 'gray' };
  if (state === 'ready') return { label: 'ready', color: 'green' };
  if (state === 'error') return { label: 'error', color: 'red' };
  if (state === 'reaped') return { label: 'reaped', color: 'amber' };
  return { label: state, color: 'blue' };
};

/** Registry spec → display chips (order preserved — it is the deploy order). */
export const specChips = (spec: unknown): EnvSpecDisplayEntry[] => {
  if (!Array.isArray(spec)) return [];
  const out: EnvSpecDisplayEntry[] = [];
  for (const [i, e] of spec.entries()) {
    const repo = String((e as Record<string, unknown>)?.repo ?? '');
    if (!repo) continue;
    const pr = (e as Record<string, unknown>)?.pr;
    const branch = (e as Record<string, unknown>)?.branch;
    if (Number.isInteger(pr)) out.push({ repo, pr: pr as number, key: `${i}:${repo}#${pr}` });
    else if (typeof branch === 'string' && branch) out.push({ repo, branch, key: `${i}:${repo}@${branch}` });
  }
  return out;
};

/**
 * TTL countdown from the registry's expires_at. Null when no TTL is armed
 * (e.g. pre-phase-3 registries); "expired" once past — the reaper tears the
 * env down on its next cycle.
 */
export const fmtCountdown = (expiresAt: string | null | undefined, now: number): string | null => {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  const ms = t - now;
  if (ms <= 0) return 'expired';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

// The event-kind taxonomy that used to live here (EVENT_FILTERS /
// eventKindTone / fmtEventMeta, added with the #213 timeline) moved to
// lib/env-event-kinds.ts when the timeline became the log explorer: the API's
// summary aggregation needs the same "what counts as an error" answer the UI
// uses, and two copies of that would drift. See admin/components/envLog.ts for
// the presentation layer built on it.
