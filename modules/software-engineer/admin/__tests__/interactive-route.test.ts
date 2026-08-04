// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises the interactive (pair-programming) control surface:
//   POST /engineers/interactive — start a live session on a project (cap-enforced, kill-switch aware)
//   POST /runs/:id/close        — end an interactive session (publish close + mark closed)
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

// Chainable supabase double. Every builder method returns `this`; terminal reads resolve from `config`
// keyed by table + operation. `await builder` (thenable) covers count queries + bare update/insert.
function mockSupabase(config: any = {}) {
  const calls = { inserts: [] as any[], updates: [] as any[] };
  const resolve = (state: any) => {
    const { table, op, selectOpts } = state;
    if (table === 'se_projects' && op === 'select') return { data: config.project ?? null, error: null };
    if (table === 'se_runs' && selectOpts?.head) return { count: config.runCount ?? 0, error: null };
    if (table === 'se_runs' && op === 'select') return { data: config.closeRun ?? null, error: null };
    if (table === 'se_runs' && op === 'insert') return config.insertResult ?? { data: { id: 'run-1' }, error: null };
    return { data: null, error: null };
  };
  const from = (table: string) => {
    const state: any = { table, op: 'select', selectOpts: undefined };
    const b: any = {
      select(_s: unknown, opts: unknown) { state.selectOpts = opts; return b; },
      insert(row: unknown) { state.op = 'insert'; calls.inserts.push({ table, row }); return b; },
      update(row: unknown) { state.op = 'update'; calls.updates.push({ table, row }); return b; },
      delete() { state.op = 'delete'; return b; },
      eq() { return b; }, is() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve(resolve(state)); },
      single() { return Promise.resolve(resolve(state)); },
      then(onF: any, onR: any) { return Promise.resolve(resolve(state)).then(onF, onR); },
    };
    return b;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }), __calls: calls };
}

function mount(supabase: unknown, extra: any = {}) {
  const router = recorderRouter();
  const published: any[] = [];
  const enqueued: any[] = [];
  mountAdminRoutes(router as never, {
    supabase,
    getRedis: () => ({ publish: (ch: string, msg: string) => { published.push({ ch, msg }); return Promise.resolve(); } }),
    logger: { warn() {}, info() {} },
    enqueueJob: async (...a: any[]) => { enqueued.push(a); return { id: 'job-1' }; },
    ...extra,
  });
  return { router, published, enqueued };
}

// A fully-configured, enabled project (github_token_ciphertext is `enc:<tok>` — the stubbed
// decryptSecret strips the prefix, so getProject sees a real token).
const PROJECT = {
  id: 'p1', site_id: 'site-1', name: 'Demo', intake_enabled: true,
  github_token_ciphertext: 'enc:ghp_demotoken', github_token_kind: 'pat',
  model_cred_ciphertext: 'enc:sk-demo', model_cred_kind: 'anthropic_api_key', model: 'claude-opus-4-8',
  issues_repo_owner: 'acme', issues_repo_name: 'issues',
  max_interactive_engineers: 1, max_concurrent_engineers: 2, autonomy_mode: 'pr_only',
};
const PID = '11111111-2222-3333-4444-555555555555';
const RID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('POST /engineers/interactive', () => {
  it('rejects a missing/invalid project_id with 400', async () => {
    const { router } = mount(mockSupabase());
    const res = mockRes();
    await router.handler('POST /engineers/interactive')({ body: { project_id: 'nope' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('404s when the project does not exist', async () => {
    const { router } = mount(mockSupabase({ project: null }));
    const res = mockRes();
    await router.handler('POST /engineers/interactive')({ body: { project_id: PID } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('409s when the project kill switch is off', async () => {
    const { router } = mount(mockSupabase({ project: { ...PROJECT, intake_enabled: false } }));
    const res = mockRes();
    await router.handler('POST /engineers/interactive')({ body: { project_id: PID } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('400s when the project has no GitHub credential', async () => {
    const { router } = mount(mockSupabase({ project: { ...PROJECT, github_token_ciphertext: null } }));
    const res = mockRes();
    await router.handler('POST /engineers/interactive')({ body: { project_id: PID } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('409s when the interactive cap is already reached', async () => {
    const { router } = mount(mockSupabase({ project: PROJECT, runCount: 1 }));  // cap = 1, one already running
    const res = mockRes();
    await router.handler('POST /engineers/interactive')({ body: { project_id: PID } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('creates a running interactive run and enqueues the worker', async () => {
    const supa = mockSupabase({ project: PROJECT, runCount: 0, insertResult: { data: { id: 'run-9' }, error: null } });
    const { router, enqueued } = mount(supa);
    const res = mockRes();
    await router.handler('POST /engineers/interactive')({ body: { project_id: PID }, userId: 'u1' }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ runId: 'run-9' });
    const insert = supa.__calls.inserts.find((c) => c.table === 'se_runs');
    expect(insert.row).toMatchObject({ kind: 'interactive', status: 'running', current_phase: 'interactive', issue_number: null });
    expect(insert.row.branch_name).toMatch(/^agent\/interactive-/);
    // enqueued to the dedicated `se` queue as software-engineer:interactive with the run id.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0][0]).toBe('se');
    expect(enqueued[0][1]).toBe('software-engineer:interactive');
    expect(enqueued[0][2]).toMatchObject({ runId: 'run-9' });
  });
});

describe('POST /runs/:id/close', () => {
  it('rejects a bad id with 400', async () => {
    const { router } = mount(mockSupabase());
    const res = mockRes();
    await router.handler('POST /runs/:id/close')({ params: { id: 'bad' }, body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('404s when the run is missing', async () => {
    const { router } = mount(mockSupabase({ closeRun: null }));
    const res = mockRes();
    await router.handler('POST /runs/:id/close')({ params: { id: RID }, body: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  it('400s when the run is not an interactive session', async () => {
    const { router } = mount(mockSupabase({ closeRun: { id: RID, site_id: 'site-1', kind: 'issue', status: 'running' } }));
    const res = mockRes();
    await router.handler('POST /runs/:id/close')({ params: { id: RID }, body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('publishes a close signal and marks an interactive run closed', async () => {
    const supa = mockSupabase({ closeRun: { id: RID, site_id: 'site-1', kind: 'interactive', status: 'running' } });
    const { router, published } = mount(supa);
    const res = mockRes();
    await router.handler('POST /runs/:id/close')({ params: { id: RID }, body: {}, userId: 'u1' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'closed' });
    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0].msg)).toEqual({ kind: 'close' });
    const upd = supa.__calls.updates.find((c) => c.table === 'se_runs');
    expect(upd.row).toEqual({ status: 'closed' });
  });
});
