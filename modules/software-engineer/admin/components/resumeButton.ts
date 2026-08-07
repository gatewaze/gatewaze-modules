/**
 * The Resume button's disabled-with-reason logic (issue #36), extracted so it is unit-testable
 * without mounting SoftwareEngineerTab.tsx (this workspace's vitest env is 'node', no jsdom).
 * A `null` result means the button is enabled; a non-null string is both the disabled reason and
 * the visible explanatory text next to the button — the button must never be a silent no-op.
 */
export function resumeBlockedReason(run: { archived_at: string | null; kind: string }): string | null {
  if (run.archived_at) return 'Unarchive to resume';
  if (run.kind === 'interactive') return "Interactive sessions can't be resumed this way";
  return null;
}
