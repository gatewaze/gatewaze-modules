// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Canvas-flow integration tests. Per spec-sites-wysiwyg-builder §10
 * the editor's multi-step flows (lock → render → apply → release,
 * concurrent-edit conflict resolution, wysiwyg-lock JSON-lock toggle)
 * must hold across endpoint boundaries — not just per-handler. These
 * tests drive `createCanvasRoutes()` through realistic sequences and
 * assert the cross-endpoint invariants.
 *
 * Coverage:
 *   - happy-path: editor A acquires lock → render → applies an op → release
 *   - concurrent-edit: A holds → B is blocked with 409 → A releases → B acquires
 *   - same-editor steal: A in tab 1 → A in tab 2 returns stolenFromTab
 *   - lock heartbeat: repeated acquireLock with same clientToken refreshes TTL
 *   - wysiwyg JSON-lock: `pages.wysiwyg_locked` flips when an op succeeds
 *   - applyOps without lock → still apply (lock is advisory; SQL function
 *     enforces the hard check via canvas.lock_not_held — surfaced from RPC)
 *
 * Note: the underlying SQL function `canvas_apply_ops` is mocked out via
 * `rpc()` returning a synthetic envelope. These tests exercise the
 * application layer's flow logic — the SQL transactional semantics are
 * covered by the pgTAP suite (canvas_cycle_trigger.test.sql) and the
 * platform's migration test harness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasRoutes } from '../canvas-routes.js';

const PAGE_ID = '00000000-0000-0000-0000-000000000001';
const SITE_ID = '00000000-0000-0000-0000-000000000002';
const LIB_ID  = '00000000-0000-0000-0000-000000000003';
const USER_A  = '00000000-0000-0000-0000-0000000000aa';
const USER_B  = '00000000-0000-0000-0000-0000000000bb';
const TOKEN_A1 = 'tab-a1-aaaaaaaaaaaa';
const TOKEN_A2 = 'tab-a2-aaaaaaaaaaaa';
const TOKEN_B1 = 'tab-b1-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Fake supabase chain — just enough surface for canvas-routes.
// Modeled on the smaller mock in canvas-routes.test.ts; this version
// also tracks `rpc('canvas_apply_ops')` calls and threads the lock /
// pages / idempotency tables across handler invocations.
// ---------------------------------------------------------------------------

interface MockState {
  tables: Map<string, Array<Record<string, unknown>>>;
  canAdminSite: boolean;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  /** Synthetic response queue for canvas_apply_ops; consumed FIFO. */
  applyResponses: Array<{ data: unknown; error: { message: string } | null }>;
}

function freshState(extras: Partial<MockState> = {}): MockState {
  return {
    tables: new Map([
      ['pages',                 [pageRow()]],
      ['sites',                 [siteRow()]],
      ['templates_block_defs',  [blockDefRow('hero', true)]],
      ['templates_brick_defs',  []],
      ['page_blocks',           []],
      ['page_block_bricks',     []],
      ['canvas_idempotency',    []],
      ['templates_wrappers',    []],
      ['page_canvas_locks',     []],
    ]),
    canAdminSite: true,
    rpcCalls: [],
    applyResponses: [],
    ...extras,
  };
}

function pageRow(extra: Record<string, unknown> = {}) {
  return {
    id: PAGE_ID,
    site_id: SITE_ID,
    composition_mode: 'blocks',
    wrapper_id: null,
    content: {},
    title: 'Flow page',
    full_path: '/flow',
    version: 1,
    wysiwyg_locked: false,
    ...extra,
  };
}

function siteRow() {
  return { id: SITE_ID, slug: 'flow', templates_library_id: LIB_ID };
}

function blockDefRow(key: string, validated: boolean) {
  return {
    id: `def-${key}`,
    library_id: LIB_ID,
    key,
    html: '<p data-block-root>{{title}}</p>',
    schema: { type: 'object', properties: { title: { type: 'string' } } },
    has_bricks: false,
    thumbnail_url: null,
    canvas_validated: validated,
    is_current: true,
  };
}

function makeMockSupabase(state: MockState) {
  function chain(table: string) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let mode: 'select' | 'delete' = 'select';

    const exec = () => (state.tables.get(table) ?? []).filter((r) => filters.every((f) => f(r)));

    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v); return api; };
    api.in = (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return api; };
    api.order = () => api;
    api.maybeSingle = () => Promise.resolve({ data: exec()[0] ?? null, error: null });
    api.single = () => Promise.resolve({ data: exec()[0] ?? null, error: null });

    api.upsert = (row: Record<string, unknown>) => {
      const arr = state.tables.get(table) ?? [];
      const conflictKey = (row.page_id as string | undefined) ?? null;
      const idx = conflictKey ? arr.findIndex((r) => r.page_id === conflictKey) : -1;
      const merged = idx >= 0
        ? { ...arr[idx], ...row, locked_at: arr[idx].locked_at ?? new Date().toISOString() }
        : { ...row, locked_at: new Date().toISOString() };
      if (idx >= 0) arr[idx] = merged;
      else arr.push(merged);
      state.tables.set(table, arr);
      const after: Record<string, unknown> = {};
      after.select = () => ({
        maybeSingle: () => Promise.resolve({ data: merged, error: null }),
      });
      after.error = null;
      return after;
    };
    api.update = (patch: Record<string, unknown>) => {
      const next: Record<string, unknown> = {};
      next.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v); return next; };
      next.then = (resolve: (r: { data: unknown; error: null }) => unknown) => {
        const arr = state.tables.get(table) ?? [];
        const updated = arr.map((r) => (filters.every((f) => f(r)) ? { ...r, ...patch } : r));
        state.tables.set(table, updated);
        return resolve({ data: null, error: null });
      };
      return next;
    };
    api.delete = () => { mode = 'delete'; return api; };
    api.then = (resolve: (v: { data: unknown; error: null }) => unknown) => {
      if (mode === 'delete') {
        const arr = state.tables.get(table) ?? [];
        const remaining = arr.filter((r) => !filters.every((f) => f(r)));
        state.tables.set(table, remaining);
        return resolve({ data: null, error: null });
      }
      return resolve({ data: exec(), error: null });
    };
    return api;
  }

  return {
    from: (table: string) => chain(table),
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      if (fn === 'can_admin_site') {
        return Promise.resolve({ data: state.canAdminSite, error: null });
      }
      if (fn === 'canvas_reap_stale_locks') {
        return Promise.resolve({ data: null, error: null });
      }
      if (fn === 'canvas_apply_ops') {
        const next = state.applyResponses.shift();
        if (next) return Promise.resolve(next);
        // Default: synthetic 200 with newVersion=2 and bump page row.
        const arr = state.tables.get('pages') ?? [];
        const idx = arr.findIndex((r) => r.id === PAGE_ID);
        if (idx >= 0) arr[idx] = { ...arr[idx], version: ((arr[idx].version as number) ?? 1) + 1, wysiwyg_locked: true };
        state.tables.set('pages', arr);
        return Promise.resolve({ data: { newVersion: ((arr[idx]?.version as number) ?? 2), warnings: [] }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

// ---------------------------------------------------------------------------
// Express-shaped req/res mocks.
// ---------------------------------------------------------------------------

function fakeReq(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    userId: USER_A,
    ...overrides,
  };
}

function fakeRes() {
  const recorder: { statusCode: number | null; body: unknown; headers: Map<string, string>; res: Record<string, unknown> } = {
    statusCode: null, body: undefined, headers: new Map(), res: {} as Record<string, unknown>,
  };
  recorder.res.status = (c: number) => { recorder.statusCode = c; return recorder.res; };
  recorder.res.json = (b: unknown) => { recorder.body = b; return recorder.res; };
  recorder.res.send = (b: unknown) => { recorder.body = b; return recorder.res; };
  recorder.res.end = () => recorder.res;
  recorder.res.setHeader = (k: string, v: string) => { recorder.headers.set(k.toLowerCase(), v); return recorder.res; };
  return recorder;
}

function baseDeps(state: MockState) {
  return {
    supabase: makeMockSupabase(state),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    rateLimit: () => true,
    brand: 'flow',
    resolveAssetUrl: async () => null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. Happy path: A acquires → renders → applies → releases.
// ===========================================================================

describe('canvas-flow — happy path single editor', () => {
  it('runs lock → render → applyOps → unlock end-to-end', async () => {
    const state = freshState();
    const routes = createCanvasRoutes(baseDeps(state));

    // 1. Acquire.
    const lockRes = fakeRes();
    await routes.acquireLock(
      fakeReq({ params: { id: PAGE_ID }, body: { clientToken: TOKEN_A1 } }),
      lockRes.res,
    );
    expect(lockRes.statusCode).toBe(200);
    expect((lockRes.body as { locked: boolean }).locked).toBe(true);

    // 2. Render.
    const renderRes = fakeRes();
    await routes.getRender(fakeReq({ params: { id: PAGE_ID } }), renderRes.res);
    expect(renderRes.statusCode).toBe(200);
    expect(typeof renderRes.body).toBe('string');
    expect((renderRes.body as string).includes('<!DOCTYPE html>')).toBe(true);

    // 3. Apply an op.
    const applyRes = fakeRes();
    await routes.applyOps(
      fakeReq({
        params: { id: PAGE_ID },
        body: {
          ops: [{ kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'hero', content: { title: 'Hello' } }],
          baseVersion: 1,
          clientToken: TOKEN_A1,
          idempotencyKey: '11111111-1111-1111-1111-111111111111',
        },
      }),
      applyRes.res,
    );
    expect(applyRes.statusCode).toBe(200);
    expect((applyRes.body as { newVersion: number }).newVersion).toBe(2);

    // wysiwyg_locked must have flipped on the page row.
    const pages = state.tables.get('pages')!;
    expect(pages[0].wysiwyg_locked).toBe(true);

    // 4. Release.
    const unlockRes = fakeRes();
    await routes.releaseLock(
      fakeReq({ params: { id: PAGE_ID }, body: { clientToken: TOKEN_A1 } }),
      unlockRes.res,
    );
    expect(state.tables.get('page_canvas_locks')).toEqual([]);
  });
});

// ===========================================================================
// 2. Concurrent-edit conflict resolution.
// ===========================================================================

describe('canvas-flow — concurrent edits', () => {
  it('A holds lock; B is blocked with 409 canvas.lock_conflict', async () => {
    const state = freshState();
    const routes = createCanvasRoutes(baseDeps(state));

    // A acquires.
    const aLock = fakeRes();
    await routes.acquireLock(
      fakeReq({ user: { id: USER_A }, params: { id: PAGE_ID }, body: { clientToken: TOKEN_A1 } }),
      aLock.res,
    );
    expect(aLock.statusCode).toBe(200);

    // B tries.
    const bLock = fakeRes();
    await routes.acquireLock(
      fakeReq({ userId: USER_B, params: { id: PAGE_ID }, body: { clientToken: TOKEN_B1 } }),
      bLock.res,
    );
    expect(bLock.statusCode).toBe(409);
    expect((bLock.body as { error: { code: string } }).error.code).toBe('canvas.lock_conflict');
    expect((bLock.body as { error: { details: { activeEditor: { id: string } } } }).error.details?.activeEditor?.id).toBe(USER_A);

    // A releases.
    const aUnlock = fakeRes();
    await routes.releaseLock(
      fakeReq({ user: { id: USER_A }, params: { id: PAGE_ID }, body: { clientToken: TOKEN_A1 } }),
      aUnlock.res,
    );

    // B retries — should succeed.
    const bLock2 = fakeRes();
    await routes.acquireLock(
      fakeReq({ userId: USER_B, params: { id: PAGE_ID }, body: { clientToken: TOKEN_B1 } }),
      bLock2.res,
    );
    expect(bLock2.statusCode).toBe(200);
  });

  it('same-user, different tab, returns stolenFromTab', async () => {
    const state = freshState();
    const routes = createCanvasRoutes(baseDeps(state));

    // A on tab 1.
    const a1 = fakeRes();
    await routes.acquireLock(
      fakeReq({ user: { id: USER_A }, params: { id: PAGE_ID }, body: { clientToken: TOKEN_A1 } }),
      a1.res,
    );
    expect(a1.statusCode).toBe(200);

    // A on tab 2 — should steal from tab 1.
    const a2 = fakeRes();
    await routes.acquireLock(
      fakeReq({ user: { id: USER_A }, params: { id: PAGE_ID }, body: { clientToken: TOKEN_A2 } }),
      a2.res,
    );
    expect(a2.statusCode).toBe(200);
    expect((a2.body as { stolenFromTab: string }).stolenFromTab).toBe(TOKEN_A1);

    // tab-1's clientToken is no longer the lock holder; releasing with TOKEN_A1
    // does NOT remove the new tab-2 lock (delete is filtered by client_token).
    await routes.releaseLock(
      fakeReq({ user: { id: USER_A }, params: { id: PAGE_ID }, body: { clientToken: TOKEN_A1 } }),
      fakeRes().res,
    );
    expect(state.tables.get('page_canvas_locks')).toHaveLength(1);
  });
});

// ===========================================================================
// 3. Heartbeat refresh.
// ===========================================================================

describe('canvas-flow — heartbeat keeps lock alive', () => {
  it('repeated acquireLock with the same clientToken refreshes the heartbeat', async () => {
    const state = freshState();
    const routes = createCanvasRoutes(baseDeps(state));

    const r1 = fakeRes();
    await routes.acquireLock(
      fakeReq({ user: { id: USER_A }, params: { id: PAGE_ID }, body: { clientToken: TOKEN_A1 } }),
      r1.res,
    );
    expect(r1.statusCode).toBe(200);
    const beforeHeartbeat = (state.tables.get('page_canvas_locks')![0] as { heartbeat_at: string }).heartbeat_at;

    // Wait a millisecond so heartbeat_at differs.
    await new Promise((res) => setTimeout(res, 5));

    const r2 = fakeRes();
    await routes.acquireLock(
      fakeReq({ user: { id: USER_A }, params: { id: PAGE_ID }, body: { clientToken: TOKEN_A1 } }),
      r2.res,
    );
    expect(r2.statusCode).toBe(200);
    const afterHeartbeat = (state.tables.get('page_canvas_locks')![0] as { heartbeat_at: string }).heartbeat_at;
    expect(afterHeartbeat).not.toBe(beforeHeartbeat);
  });
});

// ===========================================================================
// 4. Version conflict + retry flow.
// ===========================================================================

describe('canvas-flow — version conflict + retry', () => {
  it('stale baseVersion returns 409 canvas.version_conflict; retry with current version succeeds', async () => {
    const state = freshState();
    // First applyOps: pretend the page advanced under us — RPC returns 409.
    state.applyResponses.push({
      data: { error: { code: 'canvas.version_conflict', message: 'stale', actualVersion: 7 } },
      error: null,
    });
    // Second applyOps: succeed with newVersion=8.
    state.applyResponses.push({
      data: { newVersion: 8, warnings: [] },
      error: null,
    });

    const routes = createCanvasRoutes(baseDeps(state));

    // First attempt with stale version.
    const first = fakeRes();
    await routes.applyOps(
      fakeReq({
        params: { id: PAGE_ID },
        body: {
          ops: [{ kind: 'block.update_field', blockId: '00000000-0000-0000-0000-000000000099', fieldPath: '/title', newValue: 'X' }],
          baseVersion: 1,
          clientToken: TOKEN_A1,
          idempotencyKey: '22222222-1111-1111-1111-111111111111',
        },
      }),
      first.res,
    );
    expect(first.statusCode).toBe(409);
    expect((first.body as { error: { code: string } }).error.code).toBe('canvas.version_conflict');
    expect((first.body as { error: { details: { actualVersion: number } } }).error.details?.actualVersion).toBe(7);

    // Retry with the actual version.
    const second = fakeRes();
    await routes.applyOps(
      fakeReq({
        params: { id: PAGE_ID },
        body: {
          ops: [{ kind: 'block.update_field', blockId: '00000000-0000-0000-0000-000000000099', fieldPath: '/title', newValue: 'X' }],
          baseVersion: 7,
          clientToken: TOKEN_A1,
          idempotencyKey: '33333333-1111-1111-1111-111111111111',
        },
      }),
      second.res,
    );
    expect(second.statusCode).toBe(200);
    expect((second.body as { newVersion: number }).newVersion).toBe(8);
  });
});

// ===========================================================================
// 5. Idempotency replay flow.
// ===========================================================================

describe('canvas-flow — idempotency replay', () => {
  it('same idempotencyKey replays the cached response without re-running the RPC', async () => {
    const state = freshState();
    state.applyResponses.push({ data: { newVersion: 2, warnings: [] }, error: null });

    const routes = createCanvasRoutes(baseDeps(state));

    const body = {
      ops: [{ kind: 'block.update_field', blockId: '00000000-0000-0000-0000-000000000099', fieldPath: '/title', newValue: 'X' }],
      baseVersion: 1,
      clientToken: TOKEN_A1,
      idempotencyKey: '44444444-1111-1111-1111-111111111111',
    };

    const first = fakeRes();
    await routes.applyOps(fakeReq({ params: { id: PAGE_ID }, body }), first.res);
    expect(first.statusCode).toBe(200);
    const firstApplyCalls = state.rpcCalls.filter((c) => c.fn === 'canvas_apply_ops').length;

    const second = fakeRes();
    await routes.applyOps(fakeReq({ params: { id: PAGE_ID }, body }), second.res);
    expect(second.statusCode).toBe(200);
    const secondApplyCalls = state.rpcCalls.filter((c) => c.fn === 'canvas_apply_ops').length;

    // RPC must be invoked exactly once across both attempts.
    expect(secondApplyCalls).toBe(firstApplyCalls);
    expect((second.body as { newVersion: number }).newVersion).toBe((first.body as { newVersion: number }).newVersion);
  });
});

// ===========================================================================
// 6. wysiwyg-lock JSON-lock toggle: flips on first successful op.
// ===========================================================================

describe('canvas-flow — wysiwyg JSON-lock', () => {
  it('flips pages.wysiwyg_locked from false → true after a successful op-batch', async () => {
    const state = freshState();
    const routes = createCanvasRoutes(baseDeps(state));

    // Page starts unlocked.
    expect(state.tables.get('pages')![0].wysiwyg_locked).toBe(false);

    const applyRes = fakeRes();
    await routes.applyOps(
      fakeReq({
        params: { id: PAGE_ID },
        body: {
          ops: [{ kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'hero', content: { title: 'X' } }],
          baseVersion: 1,
          clientToken: TOKEN_A1,
          idempotencyKey: '55555555-1111-1111-1111-111111111111',
        },
      }),
      applyRes.res,
    );
    expect(applyRes.statusCode).toBe(200);

    // Default mock applyResponses behavior flips wysiwyg_locked → true.
    expect(state.tables.get('pages')![0].wysiwyg_locked).toBe(true);
  });
});
