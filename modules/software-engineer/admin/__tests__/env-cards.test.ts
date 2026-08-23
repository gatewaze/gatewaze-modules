/**
 * Pure display logic behind the Overview Environments section
 * (admin/components/envCards.ts): card state badges, deploy-progress mapping
 * for the multienv agent's states, registry-spec chips, the TTL countdown,
 * and the activity-timeline groupings.
 */
import { describe, it, expect } from 'vitest';
import {
  ENV_ACTIVE_STATES, envStepPct, envStateBadge, specChips, fmtCountdown,
  EVENT_FILTERS, eventKindTone, fmtEventMeta,
} from '../components/envCards';

describe('envStateBadge', () => {
  it('maps the lifecycle states to badge models', () => {
    expect(envStateBadge('ready', false)).toEqual({ label: 'ready', color: 'green' });
    expect(envStateBadge('error', false)).toEqual({ label: 'error', color: 'red' });
    expect(envStateBadge('reaped', false)).toEqual({ label: 'reaped', color: 'amber' });
    expect(envStateBadge(undefined, false)).toEqual({ label: 'torn-down', color: 'gray' });
    expect(envStateBadge('building-app', false)).toEqual({ label: 'building-app', color: 'blue' });
  });
  it('shows queued while a request is pending but the agent has not started', () => {
    expect(envStateBadge('ready', true)).toEqual({ label: 'queued', color: 'blue' });
    expect(envStateBadge(undefined, true)).toEqual({ label: 'queued', color: 'blue' });
    // Once the agent IS in a cycle state, that state wins over "queued".
    expect(envStateBadge('building-app', true)).toEqual({ label: 'building-app', color: 'blue' });
  });
});

describe('envStepPct', () => {
  it('is monotonic through the multienv deploy cycle', () => {
    const seq = ['preparing-worktrees', 'building-services', 'deploying-routes', 'building-app', 'starting-app', 'ready'];
    const pcts = seq.map((s) => envStepPct(s, false));
    expect([...pcts]).toEqual([...pcts].sort((a, b) => a - b));
    expect(pcts[pcts.length - 1]).toBe(100);
  });
  it('covers every active state', () => {
    for (const s of ENV_ACTIVE_STATES) expect(envStepPct(s, false)).toBeGreaterThan(0);
  });
  it('is 0 for terminal states unless a request is queued', () => {
    expect(envStepPct('error', false)).toBe(0);
    expect(envStepPct('reaped', false)).toBe(0);
    expect(envStepPct(undefined, true)).toBe(3);
  });
});

describe('specChips', () => {
  it('renders PR and branch entries in deploy order', () => {
    const chips = specChips([
      { repo: 'lfx-v2-newsletter-service', pr: 80 },
      { repo: 'lfx-self-serve', branch: 'feat/x' },
      { repo: 'lfx-v2-newsletter-service', pr: 81 },
    ]);
    expect(chips.map((c) => c.pr ?? c.branch)).toEqual([80, 'feat/x', 81]);
    expect(new Set(chips.map((c) => c.key)).size).toBe(3);
  });
  it('tolerates junk registries', () => {
    expect(specChips(null)).toEqual([]);
    expect(specChips('x')).toEqual([]);
    expect(specChips([{ pr: 1 }, { repo: 'r' }, null])).toEqual([]);
  });
});

describe('fmtCountdown', () => {
  const now = Date.parse('2026-08-23T12:00:00Z');
  it('formats remaining TTL compactly', () => {
    expect(fmtCountdown('2026-08-23T14:30:00Z', now)).toBe('2h 30m');
    expect(fmtCountdown('2026-08-23T12:25:00Z', now)).toBe('25m');
  });
  it('reports expiry and tolerates missing/garbage values', () => {
    expect(fmtCountdown('2026-08-23T11:00:00Z', now)).toBe('expired');
    expect(fmtCountdown(null, now)).toBeNull();
    expect(fmtCountdown('soon', now)).toBeNull();
  });
});

describe('activity timeline groupings', () => {
  it('the Errors filter covers service errors, lifecycle failures and refusals', () => {
    for (const k of ['service_error', 'fail', 'admission_refused', 'teardown_refused', 'reap_refused', 'root_demote_fallback']) {
      expect(EVENT_FILTERS.errors.kinds).toContain(k);
    }
  });
  it('the Lifecycle filter covers root-domain guarantee events', () => {
    for (const k of ['teardown_refused', 'reap_refused', 'root_promote', 'root_demote', 'root_reassert', 'root_boot_restore', 'root_demote_fallback']) {
      expect(EVENT_FILTERS.lifecycle.kinds).toContain(k);
    }
  });
  it('every non-all filter names only shaped kinds', () => {
    for (const [key, f] of Object.entries(EVENT_FILTERS)) {
      if (key === 'all') { expect(f.kinds).toBeNull(); continue; }
      for (const k of f.kinds ?? []) expect(k).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    }
  });
  it('tones: failures red, refusals amber, visits gray', () => {
    expect(eventKindTone('service_error')).toBe('red');
    expect(eventKindTone('admission_refused')).toBe('amber');
    expect(eventKindTone('teardown_refused')).toBe('amber');
    expect(eventKindTone('reap_refused')).toBe('amber');
    expect(eventKindTone('root_demote_fallback')).toBe('red');
    expect(eventKindTone('root_boot_restore')).toBe('green');
    expect(eventKindTone('visit')).toBe('gray');
    expect(eventKindTone('ready')).toBe('green');
  });
});

describe('fmtEventMeta', () => {
  it('renders scalar meta pairs and drops the rest', () => {
    expect(fmtEventMeta({ count: 3, host: 'x.pr-view.com', nested: { a: 1 } })).toBe('count=3 · host=x.pr-view.com');
    expect(fmtEventMeta(null)).toBeNull();
    expect(fmtEventMeta({ nested: {} })).toBeNull();
  });
});
