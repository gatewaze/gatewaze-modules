import { describe, expect, it } from 'vitest';
import {
  canTransition,
  assertTransition,
  isTerminal,
  legalNextStates,
  type DeploymentStatus,
} from '../state-machine.js';

describe('artifact deployment state-machine — terminals', () => {
  it("identifies terminal statuses", () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
  });

  it("identifies non-terminal statuses", () => {
    const nonTerminal: DeploymentStatus[] = [
      'queued', 'preparing', 'rendering', 'syncing_media', 'deploying', 'cancelling',
    ];
    for (const s of nonTerminal) expect(isTerminal(s)).toBe(false);
  });
});

describe('artifact deployment state-machine — happy path', () => {
  it('queued → preparing → rendering → syncing_media → deploying → succeeded', () => {
    const path: DeploymentStatus[] = [
      'queued', 'preparing', 'rendering', 'syncing_media', 'deploying', 'succeeded',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(canTransition(from, to)).toBe(true);
    }
  });
});

describe('artifact deployment state-machine — failure & cancel', () => {
  it('any non-terminal can transition to failed', () => {
    const states: DeploymentStatus[] = [
      'queued', 'preparing', 'rendering', 'syncing_media', 'deploying', 'cancelling',
    ];
    for (const s of states) expect(canTransition(s, 'failed')).toBe(true);
  });

  it('queued, preparing, rendering, syncing_media, deploying can request cancel', () => {
    const cancellable: DeploymentStatus[] = [
      'queued', 'preparing', 'rendering', 'syncing_media', 'deploying',
    ];
    for (const s of cancellable) expect(canTransition(s, 'cancelling')).toBe(true);
  });

  it('cancelling → cancelled', () => {
    expect(canTransition('cancelling', 'cancelled')).toBe(true);
  });

  it('terminals have no outgoing transitions (except identity)', () => {
    const terminals: DeploymentStatus[] = ['succeeded', 'cancelled', 'failed'];
    for (const t of terminals) {
      expect(legalNextStates(t)).toHaveLength(0);
      expect(canTransition(t, 'preparing')).toBe(false);
      expect(canTransition(t, t)).toBe(true); // identity
    }
  });
});

describe('artifact deployment state-machine — illegal transitions', () => {
  it('cannot skip from queued to deploying', () => {
    expect(canTransition('queued', 'deploying')).toBe(false);
  });

  it('cannot revive a cancelled deployment', () => {
    expect(canTransition('cancelled', 'queued')).toBe(false);
  });

  it('assertTransition throws with a clear message', () => {
    expect(() => assertTransition('queued', 'succeeded')).toThrow(/queued -> succeeded/);
  });

  it('assertTransition does not throw on identity transitions', () => {
    expect(() => assertTransition('queued', 'queued')).not.toThrow();
  });
});
