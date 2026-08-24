// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises the Clarity live-insights routes:
//   GET  /test-env/clarity          — cached snapshot + budget (never a live call)
//   POST /test-env/clarity/refresh  — operator-forced refresh, budget-guarded
//
// The invariants under test: the feature is invisible and inert when
// unconfigured; the export TOKEN never appears in a response; and the mutating
// refresh route requires an explicit Authorization: Bearer header, because
// this module's requireJwt accepts a Supabase auth COOKIE as a fallback and a
// cross-site form POST sends cookies — which for THIS route would let a forged
// request burn Clarity's 10-calls-per-day quota and blind the feature until
// 00:00 UTC. No test here makes a network call.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: () => true,
  readFileSync: () => { throw new Error('ENOENT'); },
  writeFileSync: () => {},
  readdirSync: () => [],
  statSync: () => { throw new Error('ENOENT'); },
  openSync: () => { throw new Error('ENOENT'); },
  closeSync: () => {},
  fstatSync: () => ({ size: 0 }),
  readSync: () => 0,
}));

import { mountAdminRoutes } from '../../api/admin-routes.js';

const PROJECT_ID = 'y71yyj70j3';
const TOKEN = 'test-only-not-a-real-token';

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

/** Chainable supabase double with a preloaded snapshot + budget row. */
function mockSupabase({ role = 'super_admin', snapshot = null, calls = 0 } = {}) {
  const from = (table: string) => {
    const b: any = {
      select() { return b; }, eq() { return b; }, in() { return b; }, is() { return b; },
      lt() { return Promise.resolve({ data: null, error: null }); },
      order() { return b; },
      limit() { return b; },
      delete() { return b; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      upsert() { return Promise.resolve({ data: null, error: null }); },
      update() { return b; },
      maybeSingle() {
        if (table === 'admin_profiles') return Promise.resolve({ data: { role }, error: null });
        if (table === 'se_clarity_snapshots') return Promise.resolve({ data: snapshot, error: null });
        if (table === 'se_clarity_budget') return Promise.resolve({ data: { calls }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: Function) { return Promise.resolve({ data: [], error: null }).then(resolve); },
    };
    return b;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }) };
}

function mount(supabase: unknown) {
  const router = recorderRouter();
  mountAdminRoutes(router as never, {
    supabase, getRedis: () => null, logger: { warn() {}, info() {} },
    enqueueJob: async () => ({ id: 'job-1' }),
  });
  return router;
}

let ipSeq = 0;
const request = (over: any = {}) => ({
  ip: `10.7.0.${++ipSeq}`, query: {}, params: {}, body: {},
  headers: { authorization: `Bearer test-token` },
  userId: 'user-1',
  ...over,
});

const FRESH = {
  fetched_at: new Date().toISOString(),
  num_of_days: 3,
  ok: true,
  error: null,
  payload: [{ metricName: 'Traffic', information: [{ totalSessionCount: '4', URL: 'https://lfx--nl-80.pr-view.com/' }] }],
};

beforeEach(() => {
  delete process.env.CLARITY_PROJECT_ID;
  delete process.env.CLARITY_DATA_EXPORT_TOKEN;
  vi.restoreAllMocks();
});

describe('GET /test-env/clarity', () => {
  it('reports unconfigured and touches nothing when the credential is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const h = mount(mockSupabase()).handler('GET /test-env/clarity');
    const res = mockRes();
    await h(request(), res);
    expect(res.body).toEqual({ configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves the cached snapshot without calling Clarity when it is fresh', async () => {
    process.env.CLARITY_PROJECT_ID = PROJECT_ID;
    process.env.CLARITY_DATA_EXPORT_TOKEN = TOKEN;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const h = mount(mockSupabase({ snapshot: FRESH })).handler('GET /test-env/clarity');
    const res = mockRes();
    await h(request(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.projectId).toBe(PROJECT_ID);
    expect(res.body.dashboardUrl).toContain(`/projects/view/${PROJECT_ID}/impressions`);
    expect(res.body.metrics).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never puts the export token in the response body', async () => {
    process.env.CLARITY_PROJECT_ID = PROJECT_ID;
    process.env.CLARITY_DATA_EXPORT_TOKEN = TOKEN;
    const h = mount(mockSupabase({ snapshot: FRESH })).handler('GET /test-env/clarity');
    const res = mockRes();
    await h(request(), res);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });
});

describe('POST /test-env/clarity/refresh', () => {
  it('rejects a cookie-only request without an explicit Bearer header', async () => {
    process.env.CLARITY_PROJECT_ID = PROJECT_ID;
    process.env.CLARITY_DATA_EXPORT_TOKEN = TOKEN;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const h = mount(mockSupabase()).handler('POST /test-env/clarity/refresh');
    const res = mockRes();
    await h(request({ headers: {} }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('bearer_required');
    // The point of the gate: a forged cross-site POST must not spend quota.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses when the feature is unconfigured rather than pretending to refresh', async () => {
    const h = mount(mockSupabase()).handler('POST /test-env/clarity/refresh');
    const res = mockRes();
    await h(request(), res);
    expect(res.statusCode).toBe(422);
  });

  it('reports budget exhaustion instead of collecting a 429 from Microsoft', async () => {
    process.env.CLARITY_PROJECT_ID = PROJECT_ID;
    process.env.CLARITY_DATA_EXPORT_TOKEN = TOKEN;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // calls == the hard daily cap, so the compare-and-swap cannot take a slot.
    const h = mount(mockSupabase({ calls: 10 })).handler('POST /test-env/clarity/refresh');
    const res = mockRes();
    await h(request(), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('budget_exhausted');
    expect(res.body.error.message).toMatch(/00:00 UTC/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
