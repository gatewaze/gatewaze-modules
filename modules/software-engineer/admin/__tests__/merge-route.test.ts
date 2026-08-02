// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises POST /runs/:id/merge (issue #17): the manual "Merge" action on the Runs dashboard. It
// validates the id, guards on run kind/status (a PR must exist and the run must be live), requires a
// project GitHub credential, delegates the actual merge to the shared mergeRunPrs loop, and only nudges
// pr-monitor (issue-close / archive / next-slot) when at least one PR actually merged.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable shared merge loop — the loop itself is unit-tested in lib/__tests__/merge-prs.test.ts.
const mp = vi.hoisted(() => ({ result: { merged: 0, held: 0, results: [] as any[] }, calls: [] as any[] }));
vi.mock('../../lib/merge-prs.js', () => ({
  mergeRunPrs: async (_sb: unknown, run: any, project: any) => { mp.calls.push({ run, project }); return mp.result; },
}));

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

// Chainable supabase double: `se_runs` select→maybeSingle resolves the run under test; `se_projects`
// select→maybeSingle resolves the project (getProject). `enc:` ciphertext is stripped by the stubbed decrypt.
function mockSupabase(config: any = {}) {
  const resolve = (state: any) => {
    if (state.table === 'se_runs' && state.op === 'select') return { data: config.run ?? null, error: null };
    if (state.table === 'se_projects' && state.op === 'select') return { data: config.project ?? null, error: null };
    return { data: null, error: null };
  };
  const from = (table: string) => {
    const state: any = { table, op: 'select' };
    const b: any = {
      select() { return b; },
      update() { state.op = 'update'; return b; },
      eq() { return b; }, is() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve(resolve(state)); },
      single() { return Promise.resolve(resolve(state)); },
      then(onF: any, onR: any) { return Promise.resolve(resolve(state)).then(onF, onR); },
    };
    return b;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }) };
}

function mount(supabase: unknown) {
  const router = recorderRouter();
  const enqueued: any[] = [];
  mountAdminRoutes(router as never, {
    supabase, getRedis: () => null, logger: { warn() {}, info() {} },
    enqueueJob: async (...a: any[]) => { enqueued.push(a); return { id: 'job-1' }; },
  });
  return { router, enqueued };
}

const PID = '11111111-2222-3333-4444-555555555555';
const RID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROJECT = { id: 'p1', site_id: 'site-1', name: 'Demo', github_token_ciphertext: 'enc:ghp_demotoken', github_token_kind: 'pat', autonomy_mode: 'pr_only' };
const openRun = (over: any = {}) => ({ id: RID, site_id: 'site-1', status: 'watching', kind: 'issue', project_id: PID, archived_at: null, repo_owner: 'acme', repo_name: 'app', issue_number: 7, ...over });

describe('POST /runs/:id/merge', () => {
  beforeEach(() => { mp.result = { merged: 0, held: 0, results: [] }; mp.calls.length = 0; });

  it('rejects a bad id with 400', async () => {
    const { router } = mount(mockSupabase());
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: 'nope' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('404s when the run is missing', async () => {
    const { router } = mount(mockSupabase({ run: null }));
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('409s for an interactive session (no PR)', async () => {
    const { router } = mount(mockSupabase({ run: openRun({ kind: 'interactive', status: 'running' }) }));
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('409s for an archived run', async () => {
    const { router } = mount(mockSupabase({ run: openRun({ archived_at: '2026-01-01T00:00:00Z' }) }));
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('409s when the run is already terminal (merged)', async () => {
    const { router } = mount(mockSupabase({ run: openRun({ status: 'merged' }) }));
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('409s "no open PR to merge" when the run has no PR yet (e.g. running)', async () => {
    const { router } = mount(mockSupabase({ run: openRun({ status: 'running' }) }));
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'no open PR to merge' });
  });

  it('400s when the project has no GitHub credential', async () => {
    const { router } = mount(mockSupabase({ run: openRun(), project: { ...PROJECT, github_token_ciphertext: null } }));
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('merges and nudges pr-monitor when at least one PR merges', async () => {
    mp.result = { merged: 1, held: 0, results: [{ repo: 'acme/app', pr_number: 7, outcome: 'merged' }] };
    const { router, enqueued } = mount(mockSupabase({ run: openRun(), project: PROJECT }));
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ merged: 1, held: 0, results: [{ repo: 'acme/app', pr_number: 7, outcome: 'merged' }] });
    expect(mp.calls).toHaveLength(1);
    expect(enqueued).toEqual([['jobs', 'software-engineer:pr-monitor', { runId: RID }]]);
  });

  it('returns held results without nudging pr-monitor when nothing merged', async () => {
    mp.result = { merged: 0, held: 1, results: [{ repo: 'acme/app', pr_number: 7, outcome: 'held', reason: 'blocked' }] };
    const { router, enqueued } = mount(mockSupabase({ run: openRun(), project: PROJECT }));
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ merged: 0, held: 1, results: [{ repo: 'acme/app', pr_number: 7, outcome: 'held', reason: 'blocked' }] });
    expect(enqueued).toHaveLength(0);
  });

  it('merges a changes_requested run (a PR exists in that state)', async () => {
    mp.result = { merged: 1, held: 0, results: [] };
    const { router, enqueued } = mount(mockSupabase({ run: openRun({ status: 'changes_requested' }), project: PROJECT }));
    const res = mockRes();
    await router.handler('POST /runs/:id/merge')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(200);
    expect(enqueued).toEqual([['jobs', 'software-engineer:pr-monitor', { runId: RID }]]);
  });
});
