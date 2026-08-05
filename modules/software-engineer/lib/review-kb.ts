// @ts-nocheck
/**
 * Review-learnings distillation. After a run addresses TRUSTED review feedback, this folds that
 * feedback into a durable, CITED knowledge base of review patterns — the same idea as the LFX
 * "learnings-reviewer": findings grounded in what real reviewers actually flagged, so future runs
 * avoid the same mistakes.
 *
 * Input is already trust-gated (revise only passes feedback from allow-listed reviewers), so the KB
 * derives from trusted human input. It is still written PENDING and only promoted to the recallable
 * `review-kb/` prefix when the run's PR MERGES (pr-monitor → approveRunReviewLearnings) — the merge
 * is the human's validation that the feedback (and the fix) were right. Best-effort + non-fatal.
 */
import { InProcessRunner } from './agent-session.js';
import { resolvePhaseModel } from './model-select.js';
import { writeReviewLearningsPending } from './memory.js';

/** Pull the first JSON array out of a model response (it may be fenced or wrapped in prose). */
function parseEntries(text: string): Array<{ slug: string; title: string; body: string }> {
  const m = String(text ?? '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e === 'object' && e.slug && e.body)
      .slice(0, 10)
      .map((e) => ({ slug: String(e.slug), title: String(e.title ?? e.slug), body: String(e.body) }));
  } catch {
    return [];
  }
}

/**
 * Distil a run's trusted review feedback into 0..N cited review-KB patterns, written PENDING for the
 * run. Returns {ok, pending}. Never throws.
 */
export async function distillReviewLearnings(sb: unknown, project: any, run: any, feedback: string, logger?: any): Promise<{ ok: boolean; pending?: number; reason?: string }> {
  if (!project?.modelCred || !String(feedback ?? '').trim()) return { ok: false, reason: 'no creds/feedback' };
  const prompt = [
    `You maintain a project's REVIEW-LEARNINGS knowledge base — durable, reusable patterns distilled`,
    `from what human reviewers ACTUALLY flag, so future automated runs on this project avoid the same`,
    `mistakes. Below is the TRUSTED reviewer feedback on a pull request the agent just revised.`,
    ``,
    `Extract 0..N generalizable patterns worth remembering. KEEP recurring defect shapes and`,
    `conventions ("N+1 query", "missing error handling on X", "our lists use page_size not limit").`,
    `DROP one-offs, typos, and anything specific to this single change that won't recur.`,
    ``,
    `Record ONLY observations grounded in the feedback below — never invent a rule the reviewer did`,
    `not raise. Output ONLY a JSON array (possibly empty []). Each element:`,
    `  { "slug": "<short-kebab-id>", "title": "<one line>",`,
    `    "body": "**Pattern:** …\\n**Detect:** …\\n**Citation:** PR #<n> <file:line if known>\\n**Fix:** …" }`,
    `No prose outside the JSON.`,
    ``,
    `Repo: ${run?.repo_owner}/${run?.repo_name}   PR #${run?.pr_number ?? run?.issue_number ?? '?'}`,
    ``,
    `--- TRUSTED REVIEWER FEEDBACK ---`,
    String(feedback).slice(0, 12000),
  ].join('\n');

  try {
    const runner = new InProcessRunner();
    const result = await runner.runPhase({
      cwd: '/tmp',
      prompt,
      model: resolvePhaseModel(project, null, 'review_kb').model,
      credential: { kind: project.modelCredKind, value: project.modelCred },
      allowedTools: [],
    });
    const entries = parseEntries(result?.text ?? '');
    if (entries.length === 0) return { ok: true, pending: 0, reason: 'no patterns' };
    const n = await writeReviewLearningsPending(sb, run.project_id, project.name, run.id, entries);
    logger?.info?.('se: review-learnings distilled (pending until merge)', { run: run.id, patterns: n });
    return { ok: true, pending: n };
  } catch (e: any) {
    logger?.warn?.('se: distill review-learnings failed', { run: run?.id, error: String(e?.message ?? e) });
    return { ok: false, reason: 'distill failed' };
  }
}
