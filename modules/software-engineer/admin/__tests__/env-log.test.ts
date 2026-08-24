/**
 * Pure logic behind the Environments log explorer
 * (admin/components/envLog.ts): time-range resolution, the kind-filter chip →
 * query-param mapping, consecutive-run collapsing, and the drill-down's
 * "related events" window. Everything here is what makes a high-volume log
 * readable, so it is worth pinning independently of the component.
 */
import { describe, it, expect } from 'vitest';
import {
  TIME_RANGES, KIND_FILTER_GROUPS, rangeWindow, summaryWindow, kindParam,
  groupEvents, groupSummaryText, relatedEvents, severityStyle,
  fmtClock, fmtSpan, fmtAge, COLLAPSIBLE_KINDS,
} from '../components/envLog';

const NOW = Date.parse('2026-08-23T14:30:00.000Z');
let nextId = 1;
const ev = (ts: string, kind: string, env: string | null = 'lfx--a1', meta: unknown = null, detail = 'd') => ({
  id: nextId++, ts, kind, env_label: env, detail, meta: meta as Record<string, unknown> | null,
});

describe('rangeWindow', () => {
  it('resolves the preset windows relative to now', () => {
    expect(rangeWindow('15m', NOW)).toEqual({ since: '2026-08-23T14:15:00.000Z', until: null });
    expect(rangeWindow('1h', NOW)).toEqual({ since: '2026-08-23T13:30:00.000Z', until: null });
    expect(rangeWindow('24h', NOW)).toEqual({ since: '2026-08-22T14:30:00.000Z', until: null });
  });
  it('"all" is unbounded, and so is an unknown key', () => {
    expect(rangeWindow('all', NOW)).toEqual({ since: null, until: null });
    expect(rangeWindow('nonsense', NOW)).toEqual({ since: null, until: null });
  });
  it('custom takes datetime-local strings and degrades on garbage instead of erroring', () => {
    expect(rangeWindow('custom', NOW, { from: '2026-08-23T10:00:00Z', to: '2026-08-23T12:00:00Z' }))
      .toEqual({ since: '2026-08-23T10:00:00.000Z', until: '2026-08-23T12:00:00.000Z' });
    expect(rangeWindow('custom', NOW, { from: 'not-a-date' })).toEqual({ since: null, until: null });
    expect(rangeWindow('custom', NOW)).toEqual({ since: null, until: null });
  });
  it('every preset is a real key', () => {
    for (const k of ['15m', '1h', '24h', 'all', 'custom']) {
      expect(TIME_RANGES.some((r) => r.key === k), k).toBe(true);
    }
  });
});

describe('summaryWindow', () => {
  it('gives the sparkline two ends even for the unbounded range', () => {
    expect(summaryWindow({ since: null, until: null }, NOW))
      .toEqual({ from: '2026-08-22T14:30:00.000Z', to: '2026-08-23T14:30:00.000Z' });
  });
  it('honours an explicit window', () => {
    expect(summaryWindow({ since: '2026-08-23T14:00:00.000Z', until: '2026-08-23T14:10:00.000Z' }, NOW))
      .toEqual({ from: '2026-08-23T14:00:00.000Z', to: '2026-08-23T14:10:00.000Z' });
  });
});

describe('kindParam', () => {
  it('"all" clears the kind filter', () => {
    expect(kindParam('all', [])).toBeUndefined();
  });
  it('a group chip expands to its kinds', () => {
    const errors = kindParam('errors', [])!.split(',');
    expect(errors).toContain('service_error');
    expect(errors).toContain('admission_refused');
    expect(errors).not.toContain('visit');
  });
  it('individually-picked kinds win over the group chip', () => {
    expect(kindParam('errors', ['visit'])).toBe('visit');
    expect(kindParam('all', ['visit', 'visit', 'fail'])).toBe('visit,fail');
  });
  it('every group is a real, shaped kind list', () => {
    for (const g of KIND_FILTER_GROUPS) {
      for (const k of g.kinds ?? []) expect(k).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    }
  });
});

describe('groupEvents', () => {
  it('folds a consecutive same-env visit burst into one row', () => {
    const rows = groupEvents([
      ev('2026-08-23T14:19:00Z', 'visit', 'lfx--a1', { count: 5, host: 'lfx--a1.pr-view.com' }),
      ev('2026-08-23T14:10:00Z', 'visit', 'lfx--a1', { count: 4, host: 'lfx--a1-api.pr-view.com' }),
      ev('2026-08-23T14:02:00Z', 'visit', 'lfx--a1', { count: 3, host: 'lfx--a1.pr-view.com' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 3, weight: 12, kind: 'visit', env_label: 'lfx--a1' });
    expect(rows[0].from_ts).toBe('2026-08-23T14:02:00Z');
    expect(rows[0].to_ts).toBe('2026-08-23T14:19:00Z');
    expect(rows[0].facets).toHaveLength(2);
    expect(rows[0].members).toHaveLength(3);
  });
  it('does not fold across a different env or a different kind', () => {
    const rows = groupEvents([
      ev('2026-08-23T14:19:00Z', 'visit', 'lfx--a1'),
      ev('2026-08-23T14:18:00Z', 'visit', 'lfx--b2'),
      ev('2026-08-23T14:17:00Z', 'service_error', 'lfx--b2'),
    ]);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1]);
  });
  it('does not fold across the window gap', () => {
    const rows = groupEvents([
      ev('2026-08-23T14:19:00Z', 'visit'),
      ev('2026-08-23T13:00:00Z', 'visit'),
    ], { windowMs: 15 * 60_000 });
    expect(rows).toHaveLength(2);
  });
  it('never folds lifecycle events — each one is a decision', () => {
    const rows = groupEvents([
      ev('2026-08-23T14:19:00Z', 'ready'),
      ev('2026-08-23T14:18:00Z', 'ready'),
      ev('2026-08-23T14:17:00Z', 'create'),
    ]);
    expect(rows).toHaveLength(3);
    for (const k of ['ready', 'create', 'fail', 'teardown', 'reap']) {
      expect(COLLAPSIBLE_KINDS.has(k), k).toBe(false);
    }
  });
  it('emits plain rows when collapsing is turned off', () => {
    const rows = groupEvents([
      ev('2026-08-23T14:19:00Z', 'visit'),
      ev('2026-08-23T14:18:00Z', 'visit'),
    ], { enabled: false });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });
  it('keeps every source event reachable through the members list', () => {
    const src = [
      ev('2026-08-23T14:19:00Z', 'visit'),
      ev('2026-08-23T14:18:00Z', 'visit'),
      ev('2026-08-23T14:17:00Z', 'fail'),
    ];
    const seen = groupEvents(src).flatMap((g) => g.members.map((m) => m.id));
    expect(new Set(seen)).toEqual(new Set(src.map((e) => e.id)));
  });
  it('gives every row a stable, unique React key', () => {
    const rows = groupEvents([
      ev('2026-08-23T14:19:00Z', 'visit'),
      ev('2026-08-23T14:18:00Z', 'visit'),
      ev('2026-08-23T14:17:00Z', 'fail'),
      ev('2026-08-23T14:16:00Z', 'visit'),
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe('groupSummaryText', () => {
  it('reads like "12 visits · 3 hosts · 14:02–14:19"', () => {
    const [g] = groupEvents([
      ev('2026-08-23T14:19:00Z', 'visit', 'lfx--a1', { count: 6, host: 'a' }),
      ev('2026-08-23T14:10:00Z', 'visit', 'lfx--a1', { count: 3, host: 'b' }),
      ev('2026-08-23T14:02:00Z', 'visit', 'lfx--a1', { count: 3, host: 'c' }),
    ]);
    const text = groupSummaryText(g);
    expect(text.startsWith('12 visits · 3 hosts · ')).toBe(true);
    expect(text).toContain('–');
  });
  it('names the single facet when there is only one', () => {
    const [g] = groupEvents([
      ev('2026-08-23T14:19:00Z', 'login_failure', null, { username: 'dan' }),
      ev('2026-08-23T14:18:00Z', 'login_failure', null, { username: 'dan' }),
    ]);
    expect(groupSummaryText(g).startsWith('2 failed logins · dan · ')).toBe(true);
  });
});

describe('relatedEvents', () => {
  const anchor = ev('2026-08-23T14:00:00Z', 'service_error', 'lfx--a1');
  const all = [
    anchor,
    ev('2026-08-23T14:03:00Z', 'visit', 'lfx--a1'),
    ev('2026-08-23T14:20:00Z', 'visit', 'lfx--a1'),
    ev('2026-08-23T14:01:00Z', 'visit', 'lfx--b2'),
    ev('2026-08-23T13:57:00Z', 'ready', 'lfx--a1'),
  ];
  it('returns the same env within ±5 minutes, excluding the anchor', () => {
    const r = relatedEvents(all, anchor);
    expect(r.map((e) => e.ts)).toEqual(['2026-08-23T14:03:00Z', '2026-08-23T13:57:00Z']);
  });
  it('respects a custom window', () => {
    expect(relatedEvents(all, anchor, 60_000)).toHaveLength(0);
  });
  it('matches the unattributed stream to itself, not to an env', () => {
    const shared = ev('2026-08-23T14:00:00Z', 'login_failure', null);
    const pool = [shared, ev('2026-08-23T14:01:00Z', 'login_success', null), ev('2026-08-23T14:01:00Z', 'visit', 'lfx--a1')];
    expect(relatedEvents(pool, shared).map((e) => e.kind)).toEqual(['login_success']);
  });
});

describe('presentation', () => {
  it('formats a stable monospace clock and tolerates garbage', () => {
    expect(fmtClock('2026-08-23T14:05:09Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(fmtClock('nope')).toBe('--:--:--');
  });
  it('collapses an instant span to a single clock', () => {
    expect(fmtSpan('2026-08-23T14:05:09Z', '2026-08-23T14:05:40Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(fmtSpan('2026-08-23T14:05:09Z', '2026-08-23T14:19:00Z')).toContain('–');
  });
  it('renders a compact age', () => {
    expect(fmtAge('2026-08-23T14:29:50.000Z', NOW)).toBe('10s');
    expect(fmtAge('2026-08-23T14:00:00.000Z', NOW)).toBe('30m');
    expect(fmtAge('2026-08-23T10:30:00.000Z', NOW)).toBe('4h');
    expect(fmtAge('2026-08-20T14:30:00.000Z', NOW)).toBe('3d');
    expect(fmtAge('2026-08-23T14:31:00.000Z', NOW)).toBe('0s'); // clock skew never renders negative
    expect(fmtAge('nope', NOW)).toBe('');
  });
  it('gives errors a distinct row treatment and an unknown kind a safe default', () => {
    expect(severityStyle('service_error').row).not.toBe(severityStyle('visit').row);
    expect(severityStyle('service_error').dot).toContain('red');
    expect(severityStyle('some_future_kind')).toEqual(severityStyle('create'));
  });
});
