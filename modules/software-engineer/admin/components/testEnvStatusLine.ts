/**
 * Pure parser for the test-env status detail line, split out of the component
 * files so it can be unit-tested under vitest's `node` environment (same
 * reasoning as testEnvSet.ts). The host agents (staging-test-env.sh /
 * staging-lfx-env.sh in gatewaze-environments) emit a small, stable grammar:
 *
 *   Deploy summary  — "Deployed: repo@<base7>[+#PR…] repo@<base7> …"
 *                     optionally prefixed "mainline (origin/main) " and/or
 *                     suffixed with a prose note like "(admin/portal finish
 *                     their startup builds a few minutes after this)".
 *   Live tracking   — "… — live: tracking repo@<base7>[+#PR@<head7>…] …,
 *                     refreshed <ISO>[, checked <ISO>]" — the watcher's
 *                     heartbeat rewrites this line every idle cycle; the PR
 *                     HEAD sha is included so an observer can verify a push
 *                     landed straight from the status line.
 *   Conflict freeze — "Deployed: <summary> — live refresh conflict: <what> —
 *                     env frozen at …" (state stays ready; env is frozen).
 *   In progress     — "Live refresh in progress (<repos> changed) — …".
 *
 * parseTestEnvDetail turns any of these into a structured display model; the
 * raw segments are kept so unrecognised variants pass through untouched.
 */
import type { TestEnvProfile } from './testEnvSet';

export type ParsedPr = { number: number; headSha: string | null };
export type ParsedRepo = { repo: string; baseSha: string; prs: ParsedPr[] };
export type ParsedDetail = {
  /** Detail text before any live-mode segment (verbatim, for fallback display). */
  main: string;
  /** The live-mode segment ("live: tracking …" / "live refresh …"), or null. */
  live: string | null;
  /** True when the live-tracking marker is present — env follows branch pushes. */
  liveTracking: boolean;
  /** "live refresh conflict: …" tail (env frozen until the next push), or null. */
  conflict: string | null;
  /** Structured deploy summary — prefers the live list (it carries PR heads). */
  repos: ParsedRepo[];
  /** Plain origin/main deploy (no PRs merged for at least one repo set). */
  mainline: boolean;
  /** "refreshed <ISO>" — when a change last landed in the env. */
  refreshedAt: string | null;
  /** "checked <ISO>" — the live watcher's heartbeat (poll loop is alive). */
  checkedAt: string | null;
  /** Leftover prose from the deploy summary (e.g. the startup-builds note). */
  note: string | null;
};

/**
 * Split a status detail into the main part and the live-mode part so the live
 * segment can render untruncated. Matches "live: tracking …" and the
 * "live refresh conflict/in progress" variants. (Moved here from testEnv.ts —
 * still re-exported there.)
 */
export const splitLiveDetail = (detail?: string): { main: string; live: string | null } => {
  const d = String(detail ?? '');
  const i = d.search(/live: tracking|live refresh/i);
  if (i < 0) return { main: d, live: null };
  return { main: d.slice(0, i).replace(/[\s—-]+$/, ''), live: d.slice(i) };
};

// One deploy-summary token: repo@basesha then zero or more +#PR[@headsha].
// Repo names are [A-Za-z0-9._-] (GitHub's charset), shas 7–40 hex chars.
const TOKEN = /([A-Za-z0-9][A-Za-z0-9._-]*)@([0-9a-f]{7,40})((?:\+#\d{1,5}(?:@[0-9a-f]{7,40})?)*)/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;

const parseTokens = (s: string): ParsedRepo[] => {
  const out: ParsedRepo[] = [];
  for (const m of s.matchAll(TOKEN)) {
    const prs: ParsedPr[] = [];
    for (const pm of m[3].matchAll(/\+#(\d{1,5})(?:@([0-9a-f]{7,40}))?/g)) {
      prs.push({ number: Number(pm[1]), headSha: pm[2] ?? null });
    }
    out.push({ repo: m[1], baseSha: m[2], prs });
  }
  return out;
};

export function parseTestEnvDetail(detail?: string): ParsedDetail {
  const { main, live } = splitLiveDetail(detail);
  const liveTracking = /live: tracking/i.test(live ?? '');
  // The live-tracking list carries resolved PR-head shas, so it wins over the
  // deploy summary when both are present. Timestamps never match TOKEN (they
  // contain ':' and uppercase 'T'), so the tracking list can be scanned whole.
  const liveRepos = liveTracking ? parseTokens(live as string) : [];
  const mainRepos = parseTokens(main);
  const repos = liveRepos.length > 0 ? liveRepos : mainRepos;
  const refreshedAt = (live ?? '').match(new RegExp(`refreshed (${ISO.source})`, 'i'))?.[1] ?? null;
  const checkedAt = (live ?? '').match(new RegExp(`checked (${ISO.source})`, 'i'))?.[1] ?? null;
  const conflict = (live ?? '').match(/live refresh conflict:\s*(.+)$/i)?.[1]?.trim() ?? null;
  const mainline = /mainline \(origin\/main\)/i.test(main);
  // Whatever prose remains in the deploy summary once the scaffolding and the
  // repo tokens are stripped (e.g. the admin/portal startup-builds note).
  const note = main
    .replace(/^\s*Deployed:?/i, '')
    .replace(/mainline \(origin\/main\)/i, '')
    .replace(TOKEN, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–-]+|[\s—–-]+$/g, '')
    .trim() || null;
  return { main, live, liveTracking, conflict, repos, mainline, refreshedAt, checkedAt, note };
}

// GitHub org per env profile — PR/commit links from the status line resolve
// against the org the profile's repo allowlist lives under.
export const TEST_ENV_ORG: Record<TestEnvProfile, string> = { gatewaze: 'gatewaze', lfx: 'linuxfoundation' };
// Parsed repo names and shas are regex-constrained ([A-Za-z0-9._-] / hex), so
// these interpolations cannot carry path traversal or URL metacharacters.
export const testEnvPrUrl = (profile: TestEnvProfile, repo: string, number: number): string =>
  `https://github.com/${TEST_ENV_ORG[profile]}/${repo}/pull/${number}`;
export const testEnvCommitUrl = (profile: TestEnvProfile, repo: string, sha: string): string =>
  `https://github.com/${TEST_ENV_ORG[profile]}/${repo}/commit/${sha}`;

/**
 * Compact relative age for the freshness flags ("20s ago", "3m ago"). Null on
 * missing/unparseable input; clock skew clamps to "0s ago" rather than going
 * negative (the box and the browser disagree by a few seconds routinely).
 */
export const relTime = (iso: string | null | undefined, now: number): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
