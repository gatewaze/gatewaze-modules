/**
 * Pure logic behind the ordered test-env deploy set, split out of the
 * component files so it can be unit-tested under vitest's `node` environment
 * without pulling in `@/lib/supabase`, `@/components/ui`, or heroicons (same
 * reasoning as decisionsPanelUtils.ts / projectAvatarUtils.ts).
 *
 * The deploy set is an ORDERED list and may repeat a repo — the host merges
 * same-repo PRs onto origin/main locally in this exact order (merge-queue
 * semantics; nothing is ever pushed). Cross-repo order is cosmetic.
 * Shared by the run-view TestEnvPanel and the per-profile Overview panels.
 */
export type TestEnvProfile = 'gatewaze' | 'lfx';
export type DeployEntry = { repo: string; number: number };

/** Which env profile serves a project's PRs — null hides every test-env surface. */
export function testEnvProfile(projectName?: string): TestEnvProfile | null {
  if (!projectName) return null;
  if (projectName === 'Gatewaze') return 'gatewaze';
  if (/lfx/i.test(projectName)) return 'lfx';
  return null;
}

export const inSet = (set: DeployEntry[], repo: string, number: number): boolean =>
  set.some((x) => x.repo === repo && x.number === number);

/** Checking appends (append order = merge order); unchecking removes. */
export const toggleEntry = (set: DeployEntry[], repo: string, number: number): DeployEntry[] =>
  inSet(set, repo, number)
    ? set.filter((x) => !(x.repo === repo && x.number === number))
    : [...set, { repo, number }];

/** Append a validated entry; an invalid number or duplicate returns the set unchanged. */
export const addEntry = (set: DeployEntry[], repo: string, number: number): DeployEntry[] =>
  Number.isInteger(number) && number >= 1 && number <= 99999 && !inSet(set, repo, number)
    ? [...set, { repo, number }]
    : set;

/**
 * Move entry i up/down WITHIN its repo group: swap with the nearest entry of
 * the SAME repo in that direction (same-repo order is the merge order the
 * host applies; entries of other repos in between are skipped and keep their
 * positions). No-op at the group boundary or on an invalid index.
 */
export const moveWithinRepo = (set: DeployEntry[], i: number, dir: -1 | 1): DeployEntry[] => {
  const repo = set[i]?.repo;
  if (!repo) return set;
  let j = i + dir;
  while (j >= 0 && j < set.length && set[j].repo !== repo) j += dir;
  if (j < 0 || j >= set.length) return set;
  const next = [...set];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/** Repos in first-appearance order — the grouping the deploy-set box renders. */
export const groupRepos = (set: DeployEntry[]): string[] => [...new Set(set.map((x) => x.repo))];

/**
 * Best-effort PAT source for /test-env/related in the Overview context (no
 * run, so no natural project): ANY project whose testEnvProfile matches the
 * panel's profile serves — the route only needs a project holding a GitHub
 * credential for the profile's org. Null = skip related lookups silently.
 */
export const pickRelatedProject = <P extends { name?: string }>(
  projects: P[],
  profile: TestEnvProfile,
): P | null => projects.find((p) => testEnvProfile(p?.name) === profile) ?? null;
