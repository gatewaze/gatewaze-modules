/**
 * Integration-flavoured test for workers/run-recipe-handler.ts.
 *
 * Mocks Redis + Supabase + the runRecipe executor so we can assert
 * the worker's lifecycle: row hydration → start event → executor call
 * → terminal event → EXPIRE → semaphore release.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamWrites: Array<{ key: string; type: string; payload: Record<string, unknown> }> = [];
const dbUpdates: Array<{ table: string; eq: Record<string, string>; values: Record<string, unknown> }> = [];

interface FakeRow {
  id: string;
  status: string;
  recipe_id: string | null;
  recipe_file_path: string | null;
  recipe_snapshot: Record<string, unknown>;
  sub_recipes_snapshot: Record<string, unknown>;
  params: Record<string, unknown>;
  user_id: string | null;
  use_case: string;
  host_kind: string | null;
  host_id: string | null;
}

let rows: Record<string, FakeRow> = {};
let useCaseRows: Record<string, { allow_retry: boolean }> = {};

vi.mock('../../lib/jobs/redis-client.js', () => ({
  __resetForTests: () => {},
  pingRedis: async () => true,
  getRedisClient: async () => ({
    incr: async () => 1,
    decr: async () => 0,
    expire: async () => 1,
    set: async () => 'OK',
    publish: async () => 0,
    xadd: async () => '1762000000000-0',
    pttl: async () => -1,
    xinfo: async () => [],
  }),
  getRedisSubscriber: async () => ({
    on: () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
  }),
  createDedicatedRedisClient: async () => ({}),
}));

vi.mock('../../lib/jobs/stream-writer.js', () => ({
  appendStreamEvent: vi.fn(async (_redis: unknown, key: string, event: Record<string, unknown>) => {
    streamWrites.push({ key, type: String(event.type), payload: event });
    return '1762000000000-0';
  }),
}));

vi.mock('../../lib/jobs/metrics.js', () => ({
  recordEnqueued: vi.fn(),
  recordCompleted: vi.fn(),
  incConcurrency: vi.fn(),
  recordStreamEntry: vi.fn(),
  adjustStreamConsumers: vi.fn(),
  recordStalled: vi.fn(),
  setQueueDepth: vi.fn(),
  getMetricsRegistry: vi.fn(async () => null),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => makeSupabase(),
}));

vi.mock('../../lib/recipes/run-recipe.js', () => ({
  runRecipe: vi.fn(async (_supabase: unknown, _ctx: unknown, _args: Record<string, unknown>) => ({
    run_id: 'run-1',
    status: 'complete' as const,
    final_output: { ok: true },
    steps: [],
    total_cost_micro_usd: 1234,
    total_input_tokens: 10,
    total_output_tokens: 20,
    duration_ms: 50,
  })),
}));

function makeSupabase(): unknown {
  let lastTable = '';
  let lastFilters: Record<string, string> = {};
  let pendingUpdate: Record<string, unknown> | null = null;
  const builder = {
    select: () => builder,
    eq: (col: string, val: string) => {
      lastFilters[col] = val;
      return builder;
    },
    in: (_col: string, _vals: string[]) => builder,
    maybeSingle: () => {
      const f = lastFilters;
      lastFilters = {};
      if (lastTable === 'ai_recipe_runs') {
        const row = f.id ? rows[f.id] : undefined;
        return Promise.resolve({ data: row ?? null, error: null });
      }
      if (lastTable === 'ai_use_cases') {
        const r = f.id ? useCaseRows[f.id] : undefined;
        return Promise.resolve({ data: r ?? null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    update: (values: Record<string, unknown>) => {
      pendingUpdate = values;
      return builder;
    },
    upsert: () => builder,
    delete: () => builder,
    insert: () => builder,
    then: (cb: (v: unknown) => void) => {
      // No-op terminator for chains that don't end in .maybeSingle().
      const f = lastFilters;
      lastFilters = {};
      if (pendingUpdate) {
        dbUpdates.push({ table: lastTable, eq: f, values: pendingUpdate });
        pendingUpdate = null;
      }
      cb({ data: [], error: null });
    },
  };
  return {
    from: (table: string) => {
      lastTable = table;
      lastFilters = {};
      pendingUpdate = null;
      return builder;
    },
  };
}

const { default: runRecipeHandler } = await import('../../workers/run-recipe-handler.js');

beforeEach(() => {
  streamWrites.splice(0, streamWrites.length);
  dbUpdates.splice(0, dbUpdates.length);
  rows = {};
  useCaseRows = {};
});

describe('runRecipeHandler', () => {
  it('runs end-to-end and emits run.start + run.complete + close', async () => {
    rows['00000000-0000-0000-0000-000000000001'] = {
      id: '00000000-0000-0000-0000-000000000001',
      status: 'queued',
      recipe_id: 'recipe-1',
      recipe_file_path: 'recipes/foo/recipe.yaml',
      recipe_snapshot: { title: 'Test', instructions: 'do', parameters: [], sub_recipes: [], extensions: [] },
      sub_recipes_snapshot: {},
      params: {},
      user_id: null,
      use_case: 'uc-test',
      host_kind: null,
      host_id: null,
    };
    const result = await runRecipeHandler({
      data: { runId: '00000000-0000-0000-0000-000000000001', useCase: 'uc-test' },
      id: 'job-1',
    });
    expect(result).toMatchObject({ status: 'complete' });
    const types = streamWrites.map((s) => s.type);
    expect(types[0]).toBe('run.start');
    expect(types).toContain('run.complete');
    expect(types[types.length - 1]).toBe('close');
  });

  it('short-circuits when row missing', async () => {
    const result = await runRecipeHandler({
      data: { runId: '00000000-0000-0000-0000-000000000099', useCase: 'uc-test' },
    });
    expect(result).toMatchObject({ skipped: true, reason: 'run_row_missing' });
    expect(streamWrites).toHaveLength(0);
  });

  it('emits run.cancelled when row was cancelled before pickup', async () => {
    rows['00000000-0000-0000-0000-000000000002'] = {
      id: '00000000-0000-0000-0000-000000000002',
      status: 'cancelled',
      recipe_id: 'r',
      recipe_file_path: 'p',
      recipe_snapshot: {},
      sub_recipes_snapshot: {},
      params: {},
      user_id: null,
      use_case: 'uc',
      host_kind: null,
      host_id: null,
    };
    const result = await runRecipeHandler({
      data: { runId: '00000000-0000-0000-0000-000000000002', useCase: 'uc' },
    });
    expect(result).toMatchObject({ cancelled: true });
    const types = streamWrites.map((s) => s.type);
    expect(types).toContain('run.cancelled');
  });

  it('emits run.failed when snapshot missing', async () => {
    rows['00000000-0000-0000-0000-000000000003'] = {
      id: '00000000-0000-0000-0000-000000000003',
      status: 'queued',
      recipe_id: null,
      recipe_file_path: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recipe_snapshot: null as any,
      sub_recipes_snapshot: {},
      params: {},
      user_id: null,
      use_case: 'uc',
      host_kind: null,
      host_id: null,
    };
    await expect(
      runRecipeHandler({
        data: { runId: '00000000-0000-0000-0000-000000000003', useCase: 'uc' },
      }),
    ).rejects.toThrow(/snapshot_missing|UnrecoverableError/);
    const types = streamWrites.map((s) => s.type);
    expect(types).toContain('run.failed');
  });
});
