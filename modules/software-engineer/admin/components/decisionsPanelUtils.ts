/**
 * Pure grouping/ordering logic behind <DecisionsPanel> (issue #49 §4), split out so it can be
 * unit-tested under vitest's `node` environment without pulling in the component's `@/lib/supabase`,
 * `@/components/ui`, or heroicons dependency graph (none of which resolve outside the built admin
 * app) — same reasoning as admin/components/projectAvatarUtils.ts for <ProjectAvatar>.
 */

// Fixed display order (issue #49 §4): spec → architecture → PR-ready → review-blocked →
// PR-closed-partial → config-blocked. Roughly most-actionable/most-common first.
export const KIND_ORDER = ['awaiting_spec', 'awaiting_architecture', 'ready_to_submit', 'review_blocked', 'pr_closed_partial', 'config_blocked'] as const;

export const KIND_TITLES: Record<string, string> = {
  awaiting_spec: 'Awaiting spec approval',
  awaiting_architecture: 'Architecture review',
  ready_to_submit: 'Ready to submit',
  review_blocked: 'Review blocked',
  pr_closed_partial: 'PR closed without merging',
  config_blocked: 'Blocked on configuration',
};

/** Buckets decisions by kind and orders the buckets per KIND_ORDER, dropping empty kinds. */
export function groupDecisions(decisions: any[]): Array<[string, any[]]> {
  const byKind: Record<string, any[]> = {};
  for (const d of decisions) (byKind[d.kind] ??= []).push(d);
  return KIND_ORDER.filter((k) => byKind[k]?.length).map((k) => [k, byKind[k]]);
}

// The architecture "view proposal" deep link (issue #49 §3) only makes sense for the
// awaiting_architecture kind, and only when the run actually has a resolved commit URL.
export function shouldShowArchitectureLink(kind: string, d: any): boolean {
  return kind === 'awaiting_architecture' && Boolean(d?.architecture_commit_url);
}
