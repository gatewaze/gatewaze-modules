// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it, vi } from 'vitest';
import { applyEnvelope } from '../op-handlers.js';
import type { OpEnvelope } from '../../../lib/canvas-render/index.js';

const PAGE_ID = '00000000-0000-0000-0000-000000000001';
const SITE_ID = '00000000-0000-0000-0000-000000000002';
const LIB_ID  = '00000000-0000-0000-0000-000000000003';
const USER_ID = '00000000-0000-0000-0000-000000000004';
const TOKEN   = '0123456789abcdef';

interface MockTable {
  rows: Array<Record<string, unknown>>;
}

interface MockState {
  tables: Map<string, MockTable>;
  rpcReturn: unknown;
  rpcError: { message: string } | null;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
}

function makeMockSupabase(state: MockState) {
  const fakeChain = (table: string, _select?: string) => {
    const t = state.tables.get(table) ?? { rows: [] };
    let rows = t.rows.slice();
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const api: Record<string, unknown> = {};

    const exec = () => {
      const filtered = rows.filter((r) => filters.every((f) => f(r)));
      return filtered;
    };

    api.eq = (col: string, v: unknown) => {
      filters.push((r) => r[col] === v);
      return api;
    };
    api.in = (col: string, vs: unknown[]) => {
      filters.push((r) => vs.includes(r[col]));
      return api;
    };
    api.order = () => api;
    api.limit = () => api;
    api.maybeSingle = () => Promise.resolve({ data: exec()[0] ?? null, error: null });
    api.then = (resolve: (v: { data: unknown; error: null }) => unknown) => resolve({ data: exec(), error: null });
    api.upsert = (row: Record<string, unknown>) => {
      // simple upsert — replace by primary key (page_id+idempotency_key for canvas_idempotency)
      const key = (row as { page_id?: string; idempotency_key?: string }).page_id + ':' + (row as { idempotency_key?: string }).idempotency_key;
      const existing = rows.findIndex((r) => `${r.page_id}:${r.idempotency_key}` === key);
      if (existing >= 0) rows[existing] = { ...rows[existing], ...row };
      else rows.push({ ...row });
      t.rows = rows;
      state.tables.set(table, t);
      return Promise.resolve({ data: row, error: null });
    };
    return api;
  };

  return {
    from: (table: string) => ({
      select: (_cols?: string) => fakeChain(table),
      upsert: (row: Record<string, unknown>, _opts?: unknown) => {
        const t = state.tables.get(table) ?? { rows: [] };
        const key = (row as { page_id?: string; idempotency_key?: string }).page_id + ':' + (row as { idempotency_key?: string }).idempotency_key;
        const existing = t.rows.findIndex((r) => `${r.page_id}:${r.idempotency_key}` === key);
        if (existing >= 0) t.rows[existing] = { ...t.rows[existing], ...row };
        else t.rows.push({ ...row });
        state.tables.set(table, t);
        return Promise.resolve({ data: row, error: null });
      },
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: state.rpcReturn, error: state.rpcError });
    },
  };
}

function baseDeps(state: MockState) {
  return {
    supabase: makeMockSupabase(state),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    brand: 'test',
    resolveAssetUrl: async () => null,
  };
}

function envelope(ops: OpEnvelope['ops']): OpEnvelope {
  return {
    ops,
    baseVersion: 1,
    clientToken: TOKEN,
    idempotencyKey: '11111111-1111-1111-1111-111111111111',
  };
}

function pageRow(version = 1) {
  return {
    id: PAGE_ID,
    site_id: SITE_ID,
    composition_mode: 'blocks',
    wrapper_id: null,
    content: {},
    title: 'T',
    full_path: '/x',
    version,
    wysiwyg_locked: false,
  };
}

function siteRow() {
  return { id: SITE_ID, slug: 'test', templates_library_id: LIB_ID };
}

function blockDefRow(key: string, validated = true) {
  return {
    id: `def-${key}`,
    library_id: LIB_ID,
    key,
    html: `<p>{{title}}</p>`,
    schema: { type: 'object', properties: { title: { type: 'string' } } },
    has_bricks: false,
    thumbnail_url: null,
    canvas_validated: validated,
    is_current: true,
  };
}

describe('applyEnvelope — preflight rejections', () => {
  it('returns 404 when page does not exist', async () => {
    const state: MockState = {
      tables: new Map([['pages', { rows: [] }]]),
      rpcReturn: null, rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.delete', blockId: '00000000-0000-0000-0000-000000000099' },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(404);
      expect(result.code).toBe('not_found');
    }
  });

  it('returns 409 when page is not in blocks composition mode', async () => {
    const state: MockState = {
      tables: new Map([
        ['pages', { rows: [{ ...pageRow(), composition_mode: 'schema' }] }],
      ]),
      rpcReturn: null, rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.delete', blockId: '00000000-0000-0000-0000-000000000099' },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(409);
      expect(result.code).toBe('canvas.invalid_composition_mode');
    }
  });

  it('returns 409 when site has no templates_library_id', async () => {
    const state: MockState = {
      tables: new Map([
        ['pages', { rows: [pageRow()] }],
        ['sites', { rows: [{ id: SITE_ID, slug: 'test', templates_library_id: null }] }],
      ]),
      rpcReturn: null, rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.delete', blockId: '00000000-0000-0000-0000-000000000099' },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(409);
      expect(result.code).toBe('canvas.no_library');
    }
  });
});

describe('applyEnvelope — content validation', () => {
  it('rejects block.insert with missing block_def_key', async () => {
    const state: MockState = {
      tables: new Map([
        ['pages', { rows: [pageRow()] }],
        ['sites', { rows: [siteRow()] }],
        ['templates_block_defs', { rows: [blockDefRow('hero')] }],
        ['templates_brick_defs', { rows: [] }],
        ['canvas_idempotency', { rows: [] }],
      ]),
      rpcReturn: null, rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'unknown', content: {} },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(400);
      expect(result.message).toMatch(/'unknown'/);
    }
  });

  it('rejects block.insert when block_def is not canvas_validated', async () => {
    const state: MockState = {
      tables: new Map([
        ['pages', { rows: [pageRow()] }],
        ['sites', { rows: [siteRow()] }],
        ['templates_block_defs', { rows: [blockDefRow('hero', false)] }],
        ['templates_brick_defs', { rows: [] }],
        ['canvas_idempotency', { rows: [] }],
      ]),
      rpcReturn: null, rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'hero', content: { title: 'Hi' } },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('canvas.block_def_not_validated');
    }
  });

  it('rejects block.insert with content failing schema', async () => {
    const state: MockState = {
      tables: new Map([
        ['pages', { rows: [pageRow()] }],
        ['sites', { rows: [siteRow()] }],
        ['templates_block_defs', { rows: [blockDefRow('hero')] }],
        ['templates_brick_defs', { rows: [] }],
        ['canvas_idempotency', { rows: [] }],
      ]),
      rpcReturn: null, rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'hero', content: { title: 42 } },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('canvas.field_validation');
      expect((result.details as { issues: unknown[] }).issues).toBeDefined();
    }
  });
});

describe('applyEnvelope — RPC dispatch + version conflict', () => {
  function tableSet() {
    return new Map([
      ['pages', { rows: [pageRow()] }],
      ['sites', { rows: [siteRow()] }],
      ['templates_block_defs', { rows: [blockDefRow('hero')] }],
      ['templates_brick_defs', { rows: [] }],
      ['page_blocks', { rows: [] }],
      ['page_block_bricks', { rows: [] }],
      ['canvas_idempotency', { rows: [] }],
      ['templates_wrappers', { rows: [] }],
    ]);
  }

  it('maps canvas.version_conflict from RPC to 409', async () => {
    const state: MockState = {
      tables: tableSet(),
      rpcReturn: { error: { code: 'canvas.version_conflict', message: 'stale', actualVersion: 5 } },
      rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'hero', content: { title: 'X' } },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(409);
      expect(result.code).toBe('canvas.version_conflict');
    }
  });

  it('maps canvas.lock_not_held from RPC to 403', async () => {
    const state: MockState = {
      tables: tableSet(),
      rpcReturn: { error: { code: 'canvas.lock_not_held', message: 'no lock' } },
      rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'hero', content: { title: 'X' } },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(403);
      expect(result.code).toBe('canvas.lock_not_held');
    }
  });

  it('returns 200 + render on successful apply', async () => {
    const state: MockState = {
      tables: tableSet(),
      rpcReturn: { newVersion: 2, warnings: [] },
      rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'hero', content: { title: 'X' } },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.httpStatus).toBe(200);
      expect(result.response.newVersion).toBe(2);
      expect(result.response.render.html).toContain('<!DOCTYPE html>');
      expect(result.response.warnings).toEqual([]);
    }
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].fn).toBe('canvas_apply_ops');
    expect(state.rpcCalls[0].args.p_page_id).toBe(PAGE_ID);
    expect(state.rpcCalls[0].args.p_base_version).toBe(1);
  });
});

describe('applyEnvelope — idempotency replay', () => {
  it('replays cached 200 response without calling the RPC again', async () => {
    const cachedResponse = {
      newVersion: 7,
      render: { html: '<!DOCTYPE html><html></html>', contentHash: 'abc', warnings: [] },
      warnings: [],
    };
    const state: MockState = {
      tables: new Map([
        ['canvas_idempotency', {
          rows: [{
            page_id: PAGE_ID,
            idempotency_key: '11111111-1111-1111-1111-111111111111',
            response: cachedResponse,
            http_status: 200,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          }],
        }],
        ['pages', { rows: [] }], // intentionally empty — should not be queried.
      ]),
      rpcReturn: null, rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.delete', blockId: '00000000-0000-0000-0000-000000000099' },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.newVersion).toBe(7);
    }
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('ignores expired cached responses', async () => {
    const state: MockState = {
      tables: new Map([
        ['canvas_idempotency', {
          rows: [{
            page_id: PAGE_ID,
            idempotency_key: '11111111-1111-1111-1111-111111111111',
            response: { newVersion: 99 },
            http_status: 200,
            expires_at: new Date(Date.now() - 60_000).toISOString(), // expired
          }],
        }],
        ['pages', { rows: [] }],  // page now missing → 404 from preflight
      ]),
      rpcReturn: null, rpcError: null, rpcCalls: [],
    };
    const result = await applyEnvelope(baseDeps(state), PAGE_ID, USER_ID, envelope([
      { kind: 'block.delete', blockId: '00000000-0000-0000-0000-000000000099' },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(404);
    }
  });
});
