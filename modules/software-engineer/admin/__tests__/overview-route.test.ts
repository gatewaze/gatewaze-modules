// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises GET /overview: it must validate an optional ?project UUID, delegate all aggregation to
// the se_overview() RPC (never pull run rows), and pass the payload straight through.
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

// supabase double whose rpc() records its args and returns a canned overview blob.
function mockSupabase(rpcResult: { data?: unknown; error?: unknown } = {}) {
  const calls: { rpc: string; args: unknown }[] = [];
  return {
    calls,
    rpc(name: string, args: unknown) { calls.push({ rpc: name, args }); return Promise.resolve({ data: rpcResult.data ?? null, error: rpcResult.error ?? null }); },
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
});
