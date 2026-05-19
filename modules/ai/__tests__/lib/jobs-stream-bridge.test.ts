/**
 * Tests for lib/jobs/stream-bridge.ts — offset validation.
 *
 * The XREAD → SSE forwarding loop is exercised by integration tests
 * with a real Redis (see __tests__/integration/). Unit-level checks
 * here cover the validation helper.
 */

import { describe, expect, it } from 'vitest';
import { isValidOffset } from '../../lib/jobs/stream-bridge.js';

describe('isValidOffset', () => {
  it('accepts undefined / empty (treated as tail)', () => {
    expect(isValidOffset(undefined)).toBe(true);
    expect(isValidOffset('')).toBe(true);
  });

  it('accepts $ (tail-only)', () => {
    expect(isValidOffset('$')).toBe(true);
  });

  it('accepts 0 (replay from start)', () => {
    expect(isValidOffset('0')).toBe(true);
  });

  it('accepts ms-seq format', () => {
    expect(isValidOffset('1762000050000-0')).toBe(true);
    expect(isValidOffset('1762000050000-42')).toBe(true);
  });

  it('rejects random strings', () => {
    expect(isValidOffset('hello')).toBe(false);
    expect(isValidOffset("'; DROP TABLE x;--")).toBe(false);
    expect(isValidOffset('1762000050000')).toBe(false);
    expect(isValidOffset('-0')).toBe(false);
  });
});
