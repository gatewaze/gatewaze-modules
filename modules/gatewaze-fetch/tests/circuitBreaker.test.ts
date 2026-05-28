/**
 * Unit tests for the upstream circuit breaker (spec §10.3).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../lib/circuitBreaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 60_000,
      baseOpenMs: 30_000,
      maxOpenMs: 5 * 60_000,
    });
  });

  it('starts closed', () => {
    expect(cb.isOpen()).toBe(false);
  });

  it('opens after threshold failures', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('reports retry-after seconds when open', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.retryAfterSeconds()).toBeGreaterThan(0);
  });

  it('stays closed below the threshold', () => {
    cb.recordFailure();
    cb.recordFailure();
    // Only 2 failures, threshold is 3.
    expect(cb.isOpen()).toBe(false);
    cb.recordSuccess();
    // Successes do NOT reset the failure count (failures roll off by
    // time window, not by interleaved successes — matches typical
    // sliding-window breaker semantics). One more failure trips it.
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('half-open after timeout, then probe success closes it', () => {
    const fastCb = new CircuitBreaker({
      failureThreshold: 1,
      windowMs: 60_000,
      baseOpenMs: 10, // 10ms — we'll wait past it
      maxOpenMs: 60_000,
    });
    fastCb.recordFailure();
    expect(fastCb.isOpen()).toBe(true);
    // Wait past the open window.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // isOpen() returning false transitions to half-open.
        expect(fastCb.isOpen()).toBe(false);
        // Probe success closes the breaker.
        fastCb.recordSuccess();
        expect(fastCb.isOpen()).toBe(false);
        resolve();
      }, 20);
    });
  });
});
