import { describe, it, expect } from 'vitest';
import {
  CARD_FILTERS, ACTIVE_STATUSES, OPEN_PR_STATUSES, FAILED_STATUSES, MERGED_STATUSES,
  statusesToParam, filterLabelForParam,
} from '../components/overview-filters';

// These sets MUST stay in lockstep with se_overview() (migration 007_overview_metrics.sql). If a
// SQL edit changes which statuses a KPI tile counts, this test fails until the mapping is updated —
// so a clicked tile always opens the Runs board scoped to exactly the rows it counted.
describe('card → status mapping matches se_overview() SQL', () => {
  it('Active = the live-status filter (migration 007 line 29)', () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual(
      ['blocked', 'changes_requested', 'pr_open', 'queued', 'running', 'watching'],
    );
  });
  it('Open PRs = open_prs filter (line 33)', () => {
    expect([...OPEN_PR_STATUSES].sort()).toEqual(['changes_requested', 'pr_open', 'watching']);
  });
  it('Failed / blocked = failed_blocked filter (line 34)', () => {
    expect([...FAILED_STATUSES].sort()).toEqual(['blocked', 'failed']);
  });
  it('Merged = merged status (30-day window is not reproduced on the board)', () => {
    expect([...MERGED_STATUSES]).toEqual(['merged']);
  });
  it('every mapped status is a real se_runs.status (migration 003 CHECK constraint)', () => {
    const RUN_STATUSES = new Set([
      'queued', 'running', 'blocked', 'failed', 'pr_open', 'watching', 'changes_requested', 'merged', 'closed', 'cancelled',
    ]);
    for (const card of Object.values(CARD_FILTERS)) {
      for (const s of card.statuses) expect(RUN_STATUSES.has(s)).toBe(true);
    }
  });
});

describe('statusesToParam', () => {
  it('serialises a status set into the comma-separated ?status= param', () => {
    expect(statusesToParam(OPEN_PR_STATUSES)).toBe('pr_open,watching,changes_requested');
    expect(statusesToParam(MERGED_STATUSES)).toBe('merged');
  });
});

describe('filterLabelForParam', () => {
  it('labels a known card set with the card label (order-independent)', () => {
    expect(filterLabelForParam('pr_open,watching,changes_requested')).toBe('Open PRs');
    expect(filterLabelForParam('changes_requested,pr_open,watching')).toBe('Open PRs');
    expect(filterLabelForParam('merged')).toBe('Merged');
    expect(filterLabelForParam('failed,blocked')).toBe('Failed / blocked');
  });
  it('falls back to the joined statuses for an unrecognised set', () => {
    expect(filterLabelForParam('merged,closed')).toBe('merged, closed');
  });
  it('tolerates stray whitespace and empty entries', () => {
    expect(filterLabelForParam(' failed , blocked ')).toBe('Failed / blocked');
    expect(filterLabelForParam('')).toBe('');
  });
});
