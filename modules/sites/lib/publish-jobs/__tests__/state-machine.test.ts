import { describe, expect, it } from 'vitest';
import {
  canTransition,
  assertTransition,
  isTerminal,
  legalNextStates,
  type PublishJobStatus,
} from '../state-machine.js';

describe('state-machine — terminals', () => {
  it("identifies terminal statuses correctly", () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('build_failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('conflict')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
  });

  it('does NOT mark finalization_failed as terminal (admin can retry)', () => {
    expect(isTerminal('finalization_failed')).toBe(false);
  });

  it('marks queued/preparing/etc. as non-terminal', () => {
    const nonTerminal: PublishJobStatus[] = [
      'queued', 'preparing', 'committing', 'awaiting_build',
      'build_started', 'finalizing', 'finalization_failed',
    ];
    for (const s of nonTerminal) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe('state-machine — happy path', () => {
  it('queued → preparing → committing → awaiting_build → build_started → finalizing → succeeded', () => {
    const path: PublishJobStatus[] = [
      'queued', 'preparing', 'committing', 'awaiting_build',
      'build_started', 'finalizing', 'succeeded',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(canTransition(from, to)).toBe(true);
    }
  });
});

describe('state-machine — failure paths', () => {
  it('committing can transition to conflict (stale_base from publisher)', () => {
    expect(canTransition('committing', 'conflict')).toBe(true);
  });

  it('build_started can transition to build_failed', () => {
    expect(canTransition('build_started', 'build_failed')).toBe(true);
  });

  it('any non-terminal can be cancelled (queued/preparing/committing/awaiting_build/build_started)', () => {
    const cancellable: PublishJobStatus[] = [
      'queued', 'preparing', 'committing', 'awaiting_build', 'build_started',
    ];
    for (const s of cancellable) {
      expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });
});

describe('state-machine — finalization recovery', () => {
  it('finalizing can transition to finalization_failed', () => {
    expect(canTransition('finalizing', 'finalization_failed')).toBe(true);
  });

  it('finalization_failed can be retried back to finalizing', () => {
    expect(canTransition('finalization_failed', 'finalizing')).toBe(true);
  });

  it('finalization_failed can be escalated to terminal failed', () => {
    expect(canTransition('finalization_failed', 'failed')).toBe(true);
  });

  it('finalization_failed CANNOT skip directly to succeeded', () => {
    expect(canTransition('finalization_failed', 'succeeded')).toBe(false);
  });
});

describe('state-machine — illegal transitions', () => {
  it('cannot skip from queued to succeeded', () => {
    expect(canTransition('queued', 'succeeded')).toBe(false);
    expect(() => assertTransition('queued', 'succeeded')).toThrow(/illegal transition/);
  });

  it('terminal statuses have no outgoing transitions (except identity)', () => {
    const terminals: PublishJobStatus[] = [
      'succeeded', 'build_failed', 'cancelled', 'conflict', 'failed',
    ];
    for (const t of terminals) {
      expect(legalNextStates(t)).toHaveLength(0);
      expect(canTransition(t, 'preparing')).toBe(false);
      // identity is allowed
      expect(canTransition(t, t)).toBe(true);
    }
  });

  it('cannot revive a cancelled job by re-queueing', () => {
    expect(canTransition('cancelled', 'queued')).toBe(false);
  });

  it('cannot transition from awaiting_build directly to succeeded', () => {
    expect(canTransition('awaiting_build', 'succeeded')).toBe(false);
  });
});

describe('state-machine — assertTransition', () => {
  it('throws on illegal transitions with a clear message', () => {
    expect(() => assertTransition('queued', 'finalizing')).toThrow(/queued -> finalizing/);
  });

  it('does not throw on identity transition (no-op)', () => {
    expect(() => assertTransition('queued', 'queued')).not.toThrow();
  });
});
