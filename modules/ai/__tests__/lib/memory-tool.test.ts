/**
 * memory-tool tests — covers the builtin: memory surface per spec §4.10.
 *
 * Uses a mock Supabase-like client that records every from/eq/select/
 * upsert call so we can assert the run-scoped query shape + the
 * limit/validation gates without standing up a real DB.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createMemoryTool, MEMORY_TOOL_SCHEMAS } from '../../lib/recipes/memory-tool.js';

interface MemRow { recipe_run_id: string; key: string; value: unknown }

function buildMockSupabase(initial: MemRow[] = []) {
  const rows: MemRow[] = [...initial];
  let lastTable: string | null = null;
  let mode: 'select' | 'upsert' | null = null;
  let countOnly = false;
  let upsertPayload: MemRow | null = null;
  let filters: Array<[string, string]> = [];
  const calls: string[] = [];

  const builder = {
    select(_cols: string, opts?: { count?: string; head?: boolean }) {
      mode = 'select';
      countOnly = Boolean(opts?.head);
      calls.push(`select(${_cols}${opts?.count ? `,count=${opts.count}` : ''})`);
      return builder;
    },
    eq(col: string, val: string) {
      filters.push([col, val]);
      calls.push(`eq(${col}=${val})`);
      return builder;
    },
    upsert(row: MemRow, _opts?: { onConflict: string }) {
      mode = 'upsert';
      upsertPayload = row;
      calls.push(`upsert(${row.key})`);
      return builder;
    },
    maybeSingle() {
      // If there's a pending upsert payload, materialise it now —
      // .upsert(row).select(...).maybeSingle() flips through select
      // mode before resolving, so check upsertPayload independently.
      if (upsertPayload) {
        const existingIdx = rows.findIndex(
          (r) => r.recipe_run_id === upsertPayload!.recipe_run_id && r.key === upsertPayload!.key,
        );
        const written = upsertPayload;
        if (existingIdx >= 0) rows[existingIdx] = written;
        else rows.push(written);
        upsertPayload = null;
        mode = null;
        filters = [];
        return Promise.resolve({ data: { key: written.key }, error: null });
      }
      const matched = applyFilters(rows, filters);
      filters = [];
      const head = matched[0] ?? null;
      mode = null;
      return Promise.resolve({ data: head ? { key: head.key, value: head.value } : null, error: null });
    },
    then(resolve: (v: unknown) => void) {
      // Direct await (no maybeSingle) — list_keys path returns array.
      const matched = applyFilters(rows, filters);
      const localFilters = filters;
      filters = [];
      if (mode === 'select' && countOnly) {
        countOnly = false;
        mode = null;
        resolve({ count: matched.length, data: null, error: null });
        return;
      }
      mode = null;
      void localFilters;
      resolve({ data: matched.map((r) => ({ key: r.key, value: r.value })), error: null });
    },
  };

  return {
    from(table: string) {
      lastTable = table;
      calls.push(`from(${table})`);
      filters = [];
      return builder;
    },
    rows: () => [...rows],
    calls: () => [...calls],
    lastTable: () => lastTable,
  };
}

function applyFilters(rows: MemRow[], filters: Array<[string, string]>): MemRow[] {
  return rows.filter((r) => {
    for (const [col, val] of filters) {
      if (col === 'recipe_run_id' && r.recipe_run_id !== val) return false;
      if (col === 'key' && r.key !== val) return false;
    }
    return true;
  });
}

const RUN_ID = 'run-test-1';

describe('createMemoryTool — store', () => {
  let sb: ReturnType<typeof buildMockSupabase>;
  let tool: ReturnType<typeof createMemoryTool>;
  beforeEach(() => {
    sb = buildMockSupabase();
    tool = createMemoryTool(sb, RUN_ID);
  });

  it('rejects invalid key (starts with digit)', async () => {
    const r = await tool.store('1bad', { foo: 'bar' });
    expect(r).toEqual({ ok: false, error: 'invalid_key' });
  });

  it('rejects invalid key (special chars)', async () => {
    const r = await tool.store('bad key!', { foo: 'bar' });
    expect(r).toEqual({ ok: false, error: 'invalid_key' });
  });

  it('rejects key > 128 chars', async () => {
    const r = await tool.store('a' + 'b'.repeat(128), 'v');
    expect(r).toEqual({ ok: false, error: 'invalid_key' });
  });

  it('accepts valid key + small value', async () => {
    const r = await tool.store('valid_key1', { foo: 'bar' });
    expect(r).toEqual({ ok: true });
    expect(sb.rows()).toEqual([
      expect.objectContaining({ recipe_run_id: RUN_ID, key: 'valid_key1', value: { foo: 'bar' } }),
    ]);
  });

  it('rejects value > 64 KiB', async () => {
    const big = 'x'.repeat(65 * 1024);
    const r = await tool.store('big', big);
    expect(r).toEqual({ ok: false, error: 'value_too_large' });
  });

  it('rejects non-serialisable value (circular ref)', async () => {
    type Cyclic = Record<string, unknown> & { self?: Cyclic };
    const obj: Cyclic = {};
    obj.self = obj;
    const r = await tool.store('cyc', obj);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/value_not_serialisable/);
  });

  it('enforces 100-key cap; overwrite of existing key does not count', async () => {
    const initial: MemRow[] = [];
    for (let i = 0; i < 100; i++) {
      initial.push({ recipe_run_id: RUN_ID, key: `k_${i}`, value: i });
    }
    const sb2 = buildMockSupabase(initial);
    const tool2 = createMemoryTool(sb2, RUN_ID);

    // New key beyond cap → limit_reached
    const newR = await tool2.store('k_new', 'v');
    expect(newR).toEqual({ ok: false, error: 'limit_reached' });

    // Overwriting existing key is allowed even at cap
    const overwriteR = await tool2.store('k_0', 'updated');
    expect(overwriteR).toEqual({ ok: true });
  });
});

describe('createMemoryTool — retrieve', () => {
  it('returns null for unknown key', async () => {
    const sb = buildMockSupabase();
    const tool = createMemoryTool(sb, RUN_ID);
    const r = await tool.retrieve('missing_key');
    expect(r).toEqual({ value: null });
  });

  it('returns stored value', async () => {
    const sb = buildMockSupabase([
      { recipe_run_id: RUN_ID, key: 'k1', value: { a: 1 } },
    ]);
    const tool = createMemoryTool(sb, RUN_ID);
    expect(await tool.retrieve('k1')).toEqual({ value: { a: 1 } });
  });

  it('does not return another run\'s key (scope isolation)', async () => {
    const sb = buildMockSupabase([
      { recipe_run_id: 'OTHER-RUN', key: 'shared', value: 'leak' },
    ]);
    const tool = createMemoryTool(sb, RUN_ID);
    expect(await tool.retrieve('shared')).toEqual({ value: null });
  });

  it('returns null for invalid key without hitting DB', async () => {
    const sb = buildMockSupabase();
    const tool = createMemoryTool(sb, RUN_ID);
    const r = await tool.retrieve('!@#bad');
    expect(r).toEqual({ value: null });
    // no from(...) call should have happened
    expect(sb.calls().some((c) => c.startsWith('from('))).toBe(false);
  });
});

describe('createMemoryTool — list_keys', () => {
  it('returns empty array when no keys', async () => {
    const sb = buildMockSupabase();
    const tool = createMemoryTool(sb, RUN_ID);
    expect(await tool.list_keys()).toEqual({ keys: [] });
  });

  it('returns keys sorted, scoped to run', async () => {
    const sb = buildMockSupabase([
      { recipe_run_id: RUN_ID, key: 'zebra', value: 1 },
      { recipe_run_id: RUN_ID, key: 'apple', value: 2 },
      { recipe_run_id: 'OTHER', key: 'should_not_appear', value: 3 },
    ]);
    const tool = createMemoryTool(sb, RUN_ID);
    expect(await tool.list_keys()).toEqual({ keys: ['apple', 'zebra'] });
  });
});

describe('MEMORY_TOOL_SCHEMAS', () => {
  it('exposes memory.store, memory.retrieve, memory.list_keys with valid schemas', () => {
    const names = MEMORY_TOOL_SCHEMAS.map((s) => s.name);
    expect(names).toEqual(['memory.store', 'memory.retrieve', 'memory.list_keys']);
    for (const s of MEMORY_TOOL_SCHEMAS) {
      expect(s.input_schema.type).toBe('object');
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('memory.store requires both key and value', () => {
    const s = MEMORY_TOOL_SCHEMAS.find((x) => x.name === 'memory.store')!;
    const sw = s.input_schema as { required: string[] };
    expect(sw.required).toEqual(['key', 'value']);
  });

  it('key pattern matches the runtime KEY_REGEX', () => {
    const s = MEMORY_TOOL_SCHEMAS.find((x) => x.name === 'memory.retrieve')!;
    const props = (s.input_schema as { properties: Record<string, { pattern: string }> }).properties;
    expect(props.key!.pattern).toBe('^[a-zA-Z_][a-zA-Z0-9_]{0,127}$');
  });
});
