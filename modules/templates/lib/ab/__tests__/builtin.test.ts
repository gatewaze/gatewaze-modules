import { describe, expect, it } from 'vitest';
import { BuiltinAbEngine, pickVariantDeterministic } from '../builtin.js';
import type { AbVariant } from '../../../types/index.js';

const variants: AbVariant[] = [
  { key: 'control', weight: 50 },
  { key: 'treatment', weight: 50 },
];

describe('pickVariantDeterministic', () => {
  it('returns the same variant for the same (testId, sessionKey)', () => {
    const v1 = pickVariantDeterministic(variants, 'test-1', 'session-abc');
    const v2 = pickVariantDeterministic(variants, 'test-1', 'session-abc');
    expect(v1).toBe(v2);
  });

  it('different sessionKeys can produce different variants', () => {
    const out = new Set<string>();
    for (let i = 0; i < 100; i++) {
      out.add(pickVariantDeterministic(variants, 'test-1', `session-${i}`));
    }
    expect(out.size).toBe(2);
  });

  it('returns variant key consistent with weight (50/50 within ~10% over 1000 iterations)', () => {
    const counts = { control: 0, treatment: 0 };
    for (let i = 0; i < 1000; i++) {
      const v = pickVariantDeterministic(variants, 'test-1', `session-${i}`);
      counts[v as 'control' | 'treatment']++;
    }
    expect(counts.control).toBeGreaterThan(400);
    expect(counts.control).toBeLessThan(600);
  });

  it('handles 70/30 split', () => {
    const skewed: AbVariant[] = [
      { key: 'a', weight: 70 },
      { key: 'b', weight: 30 },
    ];
    let aCount = 0;
    for (let i = 0; i < 1000; i++) {
      if (pickVariantDeterministic(skewed, 'test-1', `s-${i}`) === 'a') aCount++;
    }
    // Expect ~700 ± 50
    expect(aCount).toBeGreaterThan(650);
    expect(aCount).toBeLessThan(750);
  });

  it('returns first variant when total weight is zero (degenerate config)', () => {
    const zero: AbVariant[] = [
      { key: 'a', weight: 0 },
      { key: 'b', weight: 0 },
    ];
    expect(pickVariantDeterministic(zero, 'test-1', 'session')).toBe('a');
  });
});

describe('BuiltinAbEngine.assignVariant', () => {
  it('returns existing assignment without re-bucketing', async () => {
    const calls: string[] = [];
    const supabase = {
      rpc: async () => ({ data: null, error: null }),
      from: (_t: string) => ({
        select: (_c: string) => ({
          eq: (_c1: string, _v1: unknown) => ({
            eq: (_c2: string, _v2: unknown) => ({
              maybeSingle: async () => {
                calls.push('select');
                return { data: { variant: 'control' }, error: null };
              },
            }),
          }),
        }),
        insert: async () => {
          calls.push('insert');
          return { error: null };
        },
      }),
    };
    const engine = new BuiltinAbEngine({
      supabase,
      loadTest: async () => ({ variants, status: 'running' }),
    });
    const result = await engine.assignVariant({
      testId: 'test-1',
      sessionKey: 's',
      viewerContext: { sessionKey: 's', isLoggedIn: false },
    });
    expect(result.variant).toBe('control');
    expect(result.isNew).toBe(false);
    expect(calls).toEqual(['select']); // no insert when already assigned
  });

  it('inserts a new assignment when none exists', async () => {
    const calls: { kind: string; payload?: unknown }[] = [];
    const supabase = {
      rpc: async () => ({ data: null, error: null }),
      from: (_t: string) => ({
        select: (_c: string) => ({
          eq: (_c1: string, _v1: unknown) => ({
            eq: (_c2: string, _v2: unknown) => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        insert: async (values: Record<string, unknown>) => {
          calls.push({ kind: 'insert', payload: values });
          return { error: null };
        },
      }),
    };
    const engine = new BuiltinAbEngine({
      supabase,
      loadTest: async () => ({ variants, status: 'running' }),
    });
    const result = await engine.assignVariant({
      testId: 't1',
      sessionKey: 'session-x',
      viewerContext: { sessionKey: 'session-x', isLoggedIn: false },
    });
    expect(result.isNew).toBe(true);
    expect(['control', 'treatment']).toContain(result.variant);
    expect(calls).toHaveLength(1);
    const inserted = calls[0]?.payload as Record<string, unknown>;
    expect(inserted['test_id']).toBe('t1');
    expect(inserted['session_key']).toBe('session-x');
    expect(inserted['variant']).toBe(result.variant);
  });

  it('returns first variant without persisting when test status is not running', async () => {
    let inserted = false;
    const supabase = {
      rpc: async () => ({ data: null, error: null }),
      from: (_t: string) => ({
        select: (_c: string) => ({
          eq: (_c1: string, _v1: unknown) => ({
            eq: (_c2: string, _v2: unknown) => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        insert: async () => {
          inserted = true;
          return { error: null };
        },
      }),
    };
    const engine = new BuiltinAbEngine({
      supabase,
      loadTest: async () => ({ variants, status: 'paused' }),
    });
    const result = await engine.assignVariant({
      testId: 't1',
      sessionKey: 'session-x',
      viewerContext: { sessionKey: 'session-x', isLoggedIn: false },
    });
    expect(result.variant).toBe('control');
    expect(result.isNew).toBe(false);
    expect(inserted).toBe(false);
  });
});
