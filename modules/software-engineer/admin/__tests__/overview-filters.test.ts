import { describe, it, expect } from 'vitest';
import {
  CARD_FILTERS, ACTIVE_STATUSES, OPEN_PR_STATUSES, FAILED_STATUSES, MERGED_STATUSES,
  ALL_RUN_STATUSES, STATUS_LABELS, STATUS_COLOR,
  statusesToParam, filterLabelForParam, toggleStatusInParam, fmtCost, formatDuration,
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
  it('every mapped status is a real se_runs.status (migration 003 CHECK constraint, widened by 015/016/017/018)', () => {
    const RUN_STATUSES = new Set([
      'queued', 'running', 'blocked', 'failed', 'pr_open', 'watching', 'changes_requested', 'merged', 'closed', 'cancelled',
      'awaiting_architecture', 'architecture_in_review', 'ready_to_submit', 'awaiting_spec',
    ]);
    for (const card of Object.values(CARD_FILTERS)) {
      for (const s of card.statuses) expect(RUN_STATUSES.has(s)).toBe(true);
    }
  });
});

describe('ALL_RUN_STATUSES / STATUS_LABELS / STATUS_COLOR', () => {
  it('lists all 14 se_runs.status values (migration 003, widened by 015, 016, 017 and 018)', () => {
    expect([...ALL_RUN_STATUSES].sort()).toEqual([
      'architecture_in_review', 'awaiting_architecture', 'awaiting_spec', 'blocked', 'cancelled',
      'changes_requested', 'closed', 'failed', 'merged', 'pr_open', 'queued', 'ready_to_submit',
      'running', 'watching',
    ]);
  });
  it('has a human label for every status', () => {
    for (const s of ALL_RUN_STATUSES) expect(STATUS_LABELS[s]).toBeTruthy();
  });
  it('has a badge colour for every status', () => {
    for (const s of ALL_RUN_STATUSES) expect(STATUS_COLOR[s]).toBeTruthy();
  });
});

describe('toggleStatusInParam', () => {
  it('adds a status to an empty param', () => {
    expect(toggleStatusInParam('', 'merged')).toBe('merged');
  });
  it('adds a status to an existing set', () => {
    expect(toggleStatusInParam('merged', 'failed')).toBe('merged,failed');
  });
  it('removes a status already in the set', () => {
    expect(toggleStatusInParam('merged,failed', 'merged')).toBe('failed');
  });
  it('removing the only status yields an empty string', () => {
    expect(toggleStatusInParam('merged', 'merged')).toBe('');
  });
  it('tolerates stray whitespace in the input param', () => {
    expect(toggleStatusInParam(' merged , failed ', 'blocked')).toBe('merged,failed,blocked');
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

describe('fmtCost', () => {
  it('renders nothing for null, undefined, zero, or negative values', () => {
    expect(fmtCost(null)).toBe('');
    expect(fmtCost(undefined)).toBe('');
    expect(fmtCost(0)).toBe('');
    expect(fmtCost(-1.5)).toBe('');
    expect(fmtCost('not-a-number')).toBe('');
  });
  it('renders sub-cent spend as "<$0.01"', () => {
    expect(fmtCost(0.004)).toBe('<$0.01');
  });
  it('renders larger spend to two decimal places', () => {
    expect(fmtCost(12.5)).toBe('$12.50');
    expect(fmtCost('3.2')).toBe('$3.20');
  });
});

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration('2026-08-07T10:00:00Z', '2026-08-07T10:00:45Z')).toBe('45s');
  });
  it('renders minutes and seconds under an hour', () => {
    expect(formatDuration('2026-08-07T10:00:00Z', '2026-08-07T10:05:30Z')).toBe('5m 30s');
  });
  it('renders hours and minutes for an hour or more', () => {
    expect(formatDuration('2026-08-07T10:00:00Z', '2026-08-07T12:15:00Z')).toBe('2h 15m');
  });
  it('accepts numeric millisecond timestamps', () => {
    expect(formatDuration(1000, 4000)).toBe('3s');
  });
  it('returns empty string for a missing or unparseable start', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration('not-a-date')).toBe('');
  });
  it('clamps a negative delta (end before start) to 0s rather than a negative duration', () => {
    expect(formatDuration('2026-08-07T10:00:10Z', '2026-08-07T10:00:00Z')).toBe('0s');
  });
});
