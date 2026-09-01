// @ts-nocheck
/**
 * Authorize the AUTHOR of a PR review/comment before its text is treated as
 * actionable agent feedback.
 *
 * Why this exists: `revise` concatenates review + inline-comment bodies verbatim
 * into the prompt of a Bash-capable agent that then pushes to the PR branch —
 * and (under autonomy_mode 'auto_merge_safe') that can lead to an auto-merge. On
 * a PUBLIC GitHub repo, submitting a PR review or comment requires NO collaborator
 * access — anyone with a GitHub account can. That makes it a far broader entry
 * point than the issues/label intake path (which needs repo write access to apply
 * a label). So, unlike the label path, this MUST authorize the author.
 *
 * Trusted = an explicitly allow-listed labeller, OR the person who initiated the
 * run (they asked for the work, so they can iterate on it). An EMPTY
 * allowedLabellers list does NOT mean "anyone" here — on the label path an empty
 * list still implies repo-write access, but PR comments have no such floor, so
 * treating empty as open would be the whole vulnerability. Empty ⇒ only the run
 * initiator is trusted.
 *
 * This same predicate is the module's single APPLIER-TRUST rule for privileged
 * labels: intake's agent:model:* / agent:engine:* / agent:spec:* labels (applier
 * resolved from issue events, workers/intake.ts) and the webhook's agent:adopt
 * PR label (applier = the HMAC-verified event sender, api/webhook-routes.ts —
 * pass run=null there: no run exists yet, so ONLY allow-listed labellers count,
 * fail closed). Keep every label-privilege check on this one function.
 */
export function isTrustedFeedbackAuthor(
  login: string | undefined | null,
  project: { allowedLabellers?: string[] } | null | undefined,
  run: { labeller?: string | null } | null | undefined,
): boolean {
  if (!login) return false;
  const allow = Array.isArray(project?.allowedLabellers) ? project.allowedLabellers : [];
  if (allow.includes(login)) return true;
  if (run?.labeller && login === run.labeller) return true;
  return false;
}
