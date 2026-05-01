/**
 * Built-in A/B engine — pure DB implementation against `templates_ab_*`.
 *
 *   - Deterministic variant assignment via SHA-256(testId + sessionKey)
 *     bucketed across the configured weights.
 *   - First assignment per (test, session) is persisted to
 *     `templates_ab_assignments`; subsequent calls return the same variant.
 *   - Impressions / conversions append to `templates_ab_events`.
 *   - Summary aggregates the events table per variant.
 *
 * No external dependencies; runs in any deployment shape (Docker / k8s).
 * Suitable for moderate traffic; honest about its limits — no multivariate
 * or contextual bandits. For those, install `ab-optimizely` or `ab-growthbook`
 * which implement the same `IAbEngine` interface.
 */

import { createHash } from 'node:crypto';
import type {
  AbAssignmentResult,
  AbSummary,
  AbVariant,
  IAbEngine,
  ViewerContext,
} from '../../types/index.js';

export interface BuiltinAbEngineSupabase {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        eq(col: string, val: unknown): {
          maybeSingle(): Promise<{ data: { variant: string } | null; error: { message: string } | null }>;
        };
      };
    };
    insert(values: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
  };
}

export interface BuiltinAbEngineOptions {
  /** Inject the supabase client. */
  supabase: BuiltinAbEngineSupabase;
  /** Fetch the test row's `variants` array. Injected so unit tests don't need the DB. */
  loadTest: (testId: string) => Promise<{ variants: AbVariant[]; status: string } | null>;
}

export class BuiltinAbEngine implements IAbEngine {
  readonly id = 'builtin';

  constructor(private readonly opts: BuiltinAbEngineOptions) {}

  async assignVariant(input: {
    testId: string;
    sessionKey: string;
    viewerContext: ViewerContext;
  }): Promise<AbAssignmentResult> {
    // 1. Existing assignment? Return that.
    const existing = await this.opts.supabase
      .from('templates_ab_assignments')
      .select('variant')
      .eq('test_id', input.testId)
      .eq('session_key', input.sessionKey)
      .maybeSingle();

    if (existing.error) {
      throw new Error(`builtin a/b engine: lookup failed: ${existing.error.message}`);
    }
    if (existing.data?.variant) {
      return { variant: existing.data.variant, isNew: false };
    }

    // 2. Resolve test config; fall through to control on inactive tests.
    const test = await this.opts.loadTest(input.testId);
    if (!test || test.status !== 'running') {
      // If the test isn't running, return the FIRST declared variant as a
      // stable default. Don't write to assignments — we don't want stale
      // assignments to outlive the test.
      const fallback = test?.variants[0]?.key ?? 'a';
      return { variant: fallback, isNew: false };
    }

    const variant = pickVariantDeterministic(test.variants, input.testId, input.sessionKey);

    // 3. Persist. Race-tolerant: if a concurrent caller wrote first, the
    // ON CONFLICT in the SQL backing this insert (or our own select-then-insert
    // pattern) will keep us consistent.
    const insert = await this.opts.supabase.from('templates_ab_assignments').insert({
      test_id: input.testId,
      session_key: input.sessionKey,
      variant,
    });
    if (insert.error) {
      // If two concurrent assignVariant calls race, the second insert raises a
      // unique-constraint error. Re-read and return the winning variant.
      const reread = await this.opts.supabase
        .from('templates_ab_assignments')
        .select('variant')
        .eq('test_id', input.testId)
        .eq('session_key', input.sessionKey)
        .maybeSingle();
      if (reread.data?.variant) {
        return { variant: reread.data.variant, isNew: false };
      }
      throw new Error(`builtin a/b engine: insert failed: ${insert.error.message}`);
    }
    return { variant, isNew: true };
  }

  async recordImpression(input: {
    testId: string;
    sessionKey: string;
    variant: string;
    properties?: Record<string, unknown>;
  }): Promise<void> {
    const result = await this.opts.supabase.from('templates_ab_events').insert({
      test_id: input.testId,
      session_key: input.sessionKey,
      variant: input.variant,
      kind: 'impression',
      properties: input.properties ?? {},
    });
    if (result.error) {
      throw new Error(`builtin a/b engine: impression insert failed: ${result.error.message}`);
    }
  }

  async recordConversion(input: {
    testId: string;
    sessionKey: string;
    variant: string;
    goalEvent: string;
    properties?: Record<string, unknown>;
  }): Promise<void> {
    const result = await this.opts.supabase.from('templates_ab_events').insert({
      test_id: input.testId,
      session_key: input.sessionKey,
      variant: input.variant,
      kind: 'conversion',
      goal_event: input.goalEvent,
      properties: input.properties ?? {},
    });
    if (result.error) {
      throw new Error(`builtin a/b engine: conversion insert failed: ${result.error.message}`);
    }
  }

  async summary(testId: string): Promise<AbSummary> {
    // Backed by a SQL aggregate function created in migration 007 below.
    const result = await this.opts.supabase.rpc('templates_ab_summary', { p_test_id: testId });
    if (result.error) {
      throw new Error(`builtin a/b engine: summary failed: ${result.error.message}`);
    }
    return (result.data ?? { testId, variants: [] }) as AbSummary;
  }

  async promoteWinner(testId: string, variant: string): Promise<void> {
    const result = await this.opts.supabase.rpc('templates_ab_promote_winner', {
      p_test_id: testId,
      p_variant: variant,
    });
    if (result.error) {
      throw new Error(`builtin a/b engine: promote failed: ${result.error.message}`);
    }
  }
}

/**
 * Deterministic assignment: SHA-256(testId + ':' + sessionKey) into the
 * cumulative weight buckets. Same (test, session) always yields the same
 * variant, regardless of process restarts.
 */
export function pickVariantDeterministic(
  variants: AbVariant[],
  testId: string,
  sessionKey: string,
): string {
  if (variants.length === 0) return 'a';
  const totalWeight = variants.reduce((s, v) => s + v.weight, 0);
  if (totalWeight <= 0) return variants[0]!.key;

  // Hash to a 32-bit unsigned int.
  const digest = createHash('sha256').update(testId + ':' + sessionKey).digest();
  const bucket = digest.readUInt32BE(0) % totalWeight;

  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (bucket < acc) return v.key;
  }
  return variants[variants.length - 1]!.key;
}
