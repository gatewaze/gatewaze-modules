// @ts-nocheck
/**
 * Shared merge loop for a run's PRs (§7/§10, multi-repo). Extracted from workers/merge.ts so both the
 * autonomous auto-merge worker AND the manual "Merge" admin action (POST /runs/:id/merge) go through
 * exactly the same, safe path.
 *
 * Per open PR (se_run_prs, state 'open'):
 *   - already merged on GitHub  → record merged (outcome 'already_merged').
 *   - mergeable_state !== 'clean' → HELD (left open). A PR that is only 'behind' (out of date with base
 *     under strict branch protection) is self-healed by an "update branch" so a later tick lands it once
 *     checks re-run clean; other non-clean states just hold.
 *   - mergeable_state === 'clean' → merge (squash) and record merged.
 * The token is non-bypass, so a red/required-checks-failing PR can't be forced: mergePullRequest throws
 * and the PR is held. No token or raw error is ever returned unredacted.
 */
import { githubClient } from './github.js';
import { redactToken } from './git.js';
import { listRunPrs, upsertRunPr } from './run-state.js';

export async function mergeRunPrs(supabase, run, project, { method = 'squash' } = {}) {
  const token = project?.githubToken;
  const gh = githubClient(token);
  const openPrs = (await listRunPrs(supabase, run.id)).filter((p) => p.pr_number && p.state === 'open');
  let merged = 0, held = 0;
  const results = [];
  for (const p of openPrs) {
    const repo = `${p.repo_owner}/${p.repo_name}`;
    try {
      const info = await gh.getPullRequest(p.repo_owner, p.repo_name, p.pr_number);
      if (info.merged || info.merged_at) {
        await upsertRunPr(supabase, run, p.repo_owner, p.repo_name, { state: 'merged' });
        merged++;
        results.push({ repo, pr_number: p.pr_number, outcome: 'already_merged' });
        continue;
      }
      if (info.mergeable_state !== 'clean') {
        // 'behind' just means the branch is out of date with base (strict branch protection). Self-heal:
        // update it so required checks re-run against latest base; a later merge lands it once clean.
        // Other non-clean states (blocked/unstable/dirty/pending) need real attention → just hold.
        if (info.mergeable_state === 'behind') {
          try { await gh.updateBranch(p.repo_owner, p.repo_name, p.pr_number); } catch { /* already up to date / race — best-effort */ }
        }
        held++;
        results.push({ repo, pr_number: p.pr_number, outcome: 'held', reason: info.mergeable_state ?? 'not_clean' });
        continue;
      }
      await gh.mergePullRequest(p.repo_owner, p.repo_name, p.pr_number, method);
      await upsertRunPr(supabase, run, p.repo_owner, p.repo_name, { state: 'merged' });
      merged++;
      results.push({ repo, pr_number: p.pr_number, outcome: 'merged' });
    } catch (e) {
      // protection / race — leave the PR open and report why (redacted).
      held++;
      results.push({ repo, pr_number: p.pr_number, outcome: 'held', reason: redactToken(e?.message || String(e), token) });
    }
  }
  return { merged, held, results };
}
