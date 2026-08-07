// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises GET /overview: it must validate an optional ?project UUID, delegate all core
// aggregation to the se_overview() RPC, and merge in a best-effort spend rollup (lib/cost.ts
// computeSpendOverview) that degrades silently — including on the pre-existing mock doubles below,
// which have no .from() at all and so exercise the "spend key omitted" path for every case that
// doesn't opt in via fromResult.
import { describe, it, expect } from 'vitest';
import { mountAdminRoutes } from '../../api/admin-routes.js';

// Minimal express-router recorder: capture the handler registered for each method+path.
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

// supabase double whose rpc() records its args and returns a canned overview blob. An optional
// `fromResult` wires up .from() for the spend rollup query (computeSpendOverview); when omitted,
// .from() is absent entirely — the same shape as an instance whose client has no such method — so
// computeSpendOverview's try/catch degrades it to null and the route omits the `spend` key.
function mockSupabase(rpcResult: { data?: unknown; error?: unknown } = {}, fromResult?: { data?: unknown; error?: unknown }) {
  const calls: { rpc: string; args: unknown }[] = [];
  const fromCalls: unknown[] = [];
  const base = {
    calls,
    fromCalls,
    rpc(name: string, args: unknown) { calls.push({ rpc: name, args }); return Promise.resolve({ data: rpcResult.data ?? null, error: rpcResult.error ?? null }); },
  };
  if (!fromResult) return base;
  return {
    ...base,
    from(table: string) {
      fromCalls.push(table);
      const b: any = {
        select() { return b; },
        not() { return b; },
        gte() { return b; },
        eq() { return b; },
        then(resolve: any, reject: any) {
          return Promise.resolve({ data: fromResult.data ?? null, error: fromResult.error ?? null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
}

function mount(supabase: unknown) {
  const router = recorderRouter();
  mountAdminRoutes(router as never, { supabase, getRedis: () => null, logger: { warn() {}, info() {} }, enqueueJob: async () => {} });
  return router;
}

const SAMPLE = {
  totals: { runs: 3, active: 1, merged_30d: 2, open_prs: 1, failed_blocked: 0, tokens_input: 100, tokens_output: 50 },
  by_status: [{ status: 'merged', count: 2 }, { status: 'running', count: 1 }],
  by_phase: [{ phase: 'implement', count: 1 }],
  by_project: [],
};

describe('GET /overview', () => {
  it('returns the aggregated payload and calls se_overview with a null project when unfiltered', async () => {
    const supabase = mockSupabase({ data: SAMPLE });
    const router = mount(supabase);
    const req: any = { query: {} };
    const res = mockRes();
    await router.handler('GET /overview')(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(SAMPLE);
    expect(supabase.calls).toEqual([{ rpc: 'se_overview', args: { p_project: null } }]);
  });

  it('passes a valid ?project UUID through to the RPC', async () => {
    const supabase = mockSupabase({ data: SAMPLE });
    const router = mount(supabase);
    const project = '11111111-2222-3333-4444-555555555555';
    const req: any = { query: { project } };
    const res = mockRes();
    await router.handler('GET /overview')(req, res);
    expect(res.statusCode).toBe(200);
    expect(supabase.calls[0].args).toEqual({ p_project: project });
  });

  it('rejects a malformed ?project with 400 and never hits the RPC', async () => {
    const supabase = mockSupabase({ data: SAMPLE });
    const router = mount(supabase);
    const req: any = { query: { project: 'not-a-uuid' } };
    const res = mockRes();
    await router.handler('GET /overview')(req, res);
    expect(res.statusCode).toBe(400);
    expect(supabase.calls).toHaveLength(0);
  });

  it('returns 500 when the RPC errors', async () => {
    const supabase = mockSupabase({ error: { message: 'boom' } });
    const router = mount(supabase);
    const req: any = { query: {} };
    const res = mockRes();
    await router.handler('GET /overview')(req, res);
    expect(res.statusCode).toBe(500);
  });

  it('falls back to an empty object when the RPC returns no data', async () => {
    const supabase = mockSupabase({ data: null });
    const router = mount(supabase);
    const req: any = { query: {} };
    const res = mockRes();
    await router.handler('GET /overview')(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({});
  });

  it('merges in a spend rollup when the cost query succeeds', async () => {
    const rows = [{ cost_usd: 1.5, created_at: new Date().toISOString(), project_id: 'p1', project: { name: 'Alpha', avatar_emoji: '🚀' } }];
    const supabase = mockSupabase({ data: SAMPLE }, { data: rows });
    const router = mount(supabase);
    const req: any = { query: {} };
    const res = mockRes();
    await router.handler('GET /overview')(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.spend).toEqual({
      total_30d: 1.5,
      total_7d: 1.5,
      by_project: [{ project_id: 'p1', name: 'Alpha', avatar_emoji: '🚀', total: 1.5 }],
    });
    expect(res.body.totals).toEqual(SAMPLE.totals);
  });

  it('omits the spend key when the cost query errors (e.g. pre-012 instance missing cost_usd)', async () => {
    const supabase = mockSupabase({ data: SAMPLE }, { error: { message: 'column se_runs.cost_usd does not exist' } });
    const router = mount(supabase);
    const req: any = { query: {} };
    const res = mockRes();
    await router.handler('GET /overview')(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.spend).toBeUndefined();
    expect(res.body).toEqual(SAMPLE);
  });

  it('omits the spend key when the client has no .from() at all', async () => {
    const supabase = mockSupabase({ data: SAMPLE });
    const router = mount(supabase);
    const req: any = { query: {} };
    const res = mockRes();
    await router.handler('GET /overview')(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.spend).toBeUndefined();
    expect(res.body).toEqual(SAMPLE);
  });
});

describe('GET /overview/model-usage', () => {
  const MODELS = [{ model: 'claude-sonnet-5', phases: 12, tokens_input: 900, tokens_output: 270000, tokens_cache_read: 36900000, tokens_cache_creation: 2360000, cost_usd: 18.14 }];

  it('returns the per-model rollup and defaults the window to 7 days', async () => {
    const supabase = mockSupabase({ data: MODELS });
    const router = mount(supabase);
    const res = mockRes();
    await router.handler('GET /overview/model-usage')({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.models[0].model).toBe('claude-sonnet-5');
    expect(res.body.models[0].cacheRead).toBe(36900000);
    expect(supabase.calls[0]).toEqual({ rpc: 'se_model_usage', args: { p_project: null, p_days: 7 } });
  });

  it('clamps ?days to 1..365 and passes a valid ?project through', async () => {
    const supabase = mockSupabase({ data: MODELS });
    const router = mount(supabase);
    const project = '11111111-2222-3333-4444-555555555555';
    const res = mockRes();
    await router.handler('GET /overview/model-usage')({ query: { project, days: '999' } }, res);
    expect(res.statusCode).toBe(200);
    expect(supabase.calls[0].args).toEqual({ p_project: project, p_days: 365 });
  });

  it('rejects a malformed ?project with 400 and never hits the RPC', async () => {
    const supabase = mockSupabase({ data: MODELS });
    const router = mount(supabase);
    const res = mockRes();
    await router.handler('GET /overview/model-usage')({ query: { project: 'nope' } }, res);
    expect(res.statusCode).toBe(400);
    expect(supabase.calls).toHaveLength(0);
  });

  it('returns an empty model list when the RPC errors (best-effort)', async () => {
    const supabase = mockSupabase({ error: { message: 'no such function' } });
    const router = mount(supabase);
    const res = mockRes();
    await router.handler('GET /overview/model-usage')({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ days: 7, models: [] });
  });
});
