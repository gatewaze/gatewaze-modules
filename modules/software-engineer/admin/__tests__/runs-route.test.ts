// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises GET /runs status filtering: the board accepts a single status (backward compatible, via
// .eq) or a comma-separated set from the Overview KPI tiles (via .in), validating every value
// against the run-status allowlist so an arbitrary string can't be smuggled into the filter.
import { describe, it, expect } from 'vitest';
import { mountAdminRoutes } from '../../api/admin-routes.js';

function recorderRouter() {
  const routes = new Map<string, Function>();
  const add = (method: string) => (path: string, ...handlers: Function[]) => {
    routes.set(`${method} ${path}`, handlers[handlers.length - 1]);
  };
  return {
    use: () => {},
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    handler: (key: string) => routes.get(key),
  };
}

function mockRes() {
  const res: any = {
    statusCode: 200, body: undefined,
    status(s: number) { res.statusCode = s; return res; },
    json(b: unknown) { res.body = b; return res; },
  };
  return res;
}

// Chainable query-builder double for a single .from('se_runs') read. Records every filter call; the
// builder is thenable so `await q` resolves to a canned row set (the route does `const { data } = await q`).
function mockSupabase(rows: any[] = []) {
  const filters: { op: string; args: unknown[] }[] = [];
  const b: any = {
    _filters: filters,
    from() { return b; },
    select() { return b; },
    order() { return b; },
    limit() { return b; },
    not(...args: unknown[]) { filters.push({ op: 'not', args }); return b; },
    is(...args: unknown[]) { filters.push({ op: 'is', args }); return b; },
    eq(...args: unknown[]) { filters.push({ op: 'eq', args }); return b; },
    in(...args: unknown[]) { filters.push({ op: 'in', args }); return b; },
    then(onF: any, onR: any) { return Promise.resolve({ data: rows, error: null }).then(onF, onR); },
  };
  return b;
}

function mount(supabase: unknown) {
  const router = recorderRouter();
  mountAdminRoutes(router as never, { supabase, getRedis: () => null, logger: { warn() {}, info() {} }, enqueueJob: async () => {} });
  return router;
}

const statusFilters = (supa: any) => supa._filters.filter((f: any) => f.args[0] === 'status');

describe('GET /runs — status filtering', () => {
  it('applies no status filter when ?status is absent', async () => {
    const supa = mockSupabase([{ id: 'r1' }]);
    const router = mount(supa);
    const res = mockRes();
    await router.handler('GET /runs')({ query: {} }, res);
    expect(res.body).toEqual({ runs: [{ id: 'r1' }] });
    expect(statusFilters(supa)).toHaveLength(0);
  });

  it('uses .eq for a single valid status (backward compatible)', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'merged' } }, mockRes());
    expect(statusFilters(supa)).toEqual([{ op: 'eq', args: ['status', 'merged'] }]);
  });

  it('uses .in for a comma-separated set, keeping only valid statuses in order', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'pr_open,watching,changes_requested' } }, mockRes());
    expect(statusFilters(supa)).toEqual([{ op: 'in', args: ['status', ['pr_open', 'watching', 'changes_requested']] }]);
  });

  it('drops invalid values from a set but keeps the valid ones', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'failed,bogus,blocked' } }, mockRes());
    expect(statusFilters(supa)).toEqual([{ op: 'in', args: ['status', ['failed', 'blocked']] }]);
  });

  it('collapses an all-invalid set to .in([]) so it returns no rows (never the whole board)', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'evil,injection' } }, mockRes());
    expect(statusFilters(supa)).toEqual([{ op: 'in', args: ['status', []] }]);
  });

  it('an invalid single status matches nothing instead of dumping the board', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'id.gt.0' } }, mockRes());
    // single value → .eq with a sentinel that no row has, not a dropped filter.
    expect(statusFilters(supa)).toEqual([{ op: 'eq', args: ['status', '__none__'] }]);
  });

  it('dedupes repeated statuses in a set', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'failed,failed,blocked' } }, mockRes());
    expect(statusFilters(supa)).toEqual([{ op: 'in', args: ['status', ['failed', 'blocked']] }]);
  });

  // Migration 016 widened the CHECK constraint to add the architecture-review flow's two statuses;
  // the allowlist here previously lagged behind, silently returning zero rows for either filter.
  it('accepts awaiting_architecture as a single valid status', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'awaiting_architecture' } }, mockRes());
    expect(statusFilters(supa)).toEqual([{ op: 'eq', args: ['status', 'awaiting_architecture'] }]);
  });

  it('accepts architecture_in_review in a status set', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'architecture_in_review,awaiting_architecture' } }, mockRes());
    expect(statusFilters(supa)).toEqual([{ op: 'in', args: ['status', ['architecture_in_review', 'awaiting_architecture']] }]);
  });

  // Migrations 017 (ready_to_submit) and 018 (awaiting_spec) previously lagged behind the same way —
  // the allowlist here silently returned zero rows for either filter until fixed.
  it('accepts awaiting_spec as a single valid status', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'awaiting_spec' } }, mockRes());
    expect(statusFilters(supa)).toEqual([{ op: 'eq', args: ['status', 'awaiting_spec'] }]);
  });

  it('accepts ready_to_submit in a status set', async () => {
    const supa = mockSupabase();
    const router = mount(supa);
    await router.handler('GET /runs')({ query: { status: 'ready_to_submit,awaiting_spec' } }, mockRes());
    expect(statusFilters(supa)).toEqual([{ op: 'in', args: ['status', ['ready_to_submit', 'awaiting_spec']] }]);
  });
});
