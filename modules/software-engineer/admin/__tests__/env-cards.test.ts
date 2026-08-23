/**
 * Pure display logic behind the Overview Environments section
 * (admin/components/envCards.ts): card state badges, deploy-progress mapping
 * for the multienv agent's states, registry-spec chips, the TTL countdown,
 * and the TTL countdown. (The event-kind taxonomy that used to live here moved
 * to lib/env-event-kinds.ts — covered by lib/__tests__/env-event-kinds.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import {
  ENV_ACTIVE_STATES, envStepPct, envStateBadge, specChips, fmtCountdown,
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
