import { describe, it, expect } from 'vitest';
import { resumeBlockedReason } from '../components/resumeButton';

// Issue #36 — the Resume button on a failed run's detail view must never be a silent no-op: when
// it's disabled, a visible reason is shown next to it. SoftwareEngineerTab.tsx can't be mounted
// under this module's `node` vitest env (no jsdom), so the disabled-with-reason decision is
// extracted into a pure function and pinned here (see triage-button-styles.test.ts for precedent).
describe('resumeBlockedReason', () => {
  it('is enabled (null) for a plain failed, non-archived, non-interactive run', () => {
    expect(resumeBlockedReason({ archived_at: null, kind: 'issue' })).toBeNull();
  });

  it('blocks with a visible reason when the run is archived', () => {
    expect(resumeBlockedReason({ archived_at: '2026-01-01T00:00:00Z', kind: 'issue' })).toBe('Unarchive to resume');
  });

  it('blocks with a visible reason for an interactive session', () => {
    expect(resumeBlockedReason({ archived_at: null, kind: 'interactive' })).toBe("Interactive sessions can't be resumed this way");
  });

  it('archived takes precedence when a run is somehow both archived and interactive', () => {
    expect(resumeBlockedReason({ archived_at: '2026-01-01T00:00:00Z', kind: 'interactive' })).toBe('Unarchive to resume');
  });
});
