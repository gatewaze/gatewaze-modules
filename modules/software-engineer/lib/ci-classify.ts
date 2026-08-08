// @ts-nocheck
/**
 * CI-failure classification (issue #54). Pure functions — no I/O — so the decision table is
 * unit-testable, mirroring lib/pr-status.ts. Decides whether a red PR's failing checks are
 * ADDRESSABLE by an in-repo code change, or EXTERNAL (infra incident, repo-wide upstream breakage) —
 * so pr-monitor can skip spending a bounded CI-fix pass on something no diff can fix.
 *
 * Two cheap, deterministic signals are checked first (no model call, no cost):
 *   - the same check name is currently red on the base branch's HEAD → repo-wide, not this PR's diff.
 *   - the job's steps/conclusion or log tail match a known infrastructure-failure shape.
 * Only a check that fails BOTH signals is "ambiguous" and falls through to a one-turn model read
 * (see workers/pr-monitor.ts's classifyCiFailure, which does the I/O and calls these).
 */

/** Log-line shapes seen from real GitHub Actions infra incidents — not application failures. */
export const INFRA_LOG_PATTERNS = [
  /Failed to resolve action download info/i,
  /Service Unavailable/i,
  /Failed to download.*index files|index files failed to download/i,
  /runner has been (lost|removed)/i,
  /timeout.*no steps? (ran|executed)/i,
];

export interface JobSignal {
  name: string;
  steps: Array<{ status: string; conclusion: string | null }>;
  conclusion: string | null;
  /** Fetched only when the empty-steps/conclusion check doesn't already decide it. */
  logTail?: string;
}

/** A single job's deterministic verdict. 'ambiguous' means "no infra signal found" — it may still be
 *  a real, addressable failure; the caller falls through to a model read for these. */
export function classifyJobDeterministic(job: JobSignal): 'infra' | 'ambiguous' {
  if (!job) return 'ambiguous';
  if (!job.steps?.length) return 'infra'; // cancelled/startup_failure before any step ran
  if (
    ['cancelled', 'startup_failure'].includes(String(job.conclusion)) &&
    job.steps.every((s) => s.status !== 'completed')
  ) {
    return 'infra';
  }
  if (job.logTail && INFRA_LOG_PATTERNS.some((p) => p.test(job.logTail))) return 'infra';
  return 'ambiguous';
}

export interface ClassifyCheckInput {
  name: string;
  job?: JobSignal | null;
}

export interface ClassifyInput {
  failingChecks: ClassifyCheckInput[];
  /** Check names currently red on the base branch's HEAD. */
  baseFailingCheckNames: Set<string>;
}

export type CiVerdict = 'external' | 'addressable' | 'ambiguous';

export interface ClassifyResult {
  verdict: CiVerdict;
  reasons: string[];
  /** Failing check names that resolved neither to "also red on main" nor to an infra signal — these
   *  need the model (or, absent that, are treated as addressable — see the fail-safe note below). */
  ambiguousChecks: string[];
}

/** Classify every failing check using ONLY the cheap deterministic signals. A check resolves
 *  'external' (via one of the two signals) or stays ambiguous — never "addressable" here, since
 *  a deterministic pass has no way to positively confirm a fix is possible, only to rule out
 *  external causes. The verdict is 'external' only when every failing check resolved that way. */
export function classifyDeterministic(input: ClassifyInput): ClassifyResult {
  const reasons: string[] = [];
  const ambiguousChecks: string[] = [];
  for (const c of input.failingChecks ?? []) {
    if (input.baseFailingCheckNames?.has(c.name)) {
      reasons.push(`"${c.name}" is also red on main — repo-wide, not this PR's diff`);
      continue;
    }
    if (c.job && classifyJobDeterministic(c.job) === 'infra') {
      reasons.push(`"${c.name}" failed with infrastructure signals (empty/cancelled steps or a known infra log pattern)`);
      continue;
    }
    ambiguousChecks.push(c.name);
  }
  const verdict: CiVerdict = ambiguousChecks.length === 0 ? 'external' : 'ambiguous';
  return { verdict, reasons, ambiguousChecks };
}
