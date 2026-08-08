// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises POST /runs/:id/resume (issue #36): the admin action that restarts a failed run from the
// phase that actually failed, threading an incremented attempt through so the prior FAILED se_phases
// row is preserved (see lib/run-state.ts's recordPhaseStart) rather than clobbered by the retry.
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

// Chainable supabase double covering the tables/ops the /resume route touches: se_runs (select the run,
// then an atomic conditional update), se_phases (the latest-failed lookup, then a head:true count for the
// next attempt number), se_projects (the approver-list lookup inside denyIfNotApprover), se_messages
// (the system note insert), se_events (denyIfNotApprover's best-effort refusal-audit insert — unused on
// the allow path exercised here).
function mockSupabase(config: any = {}) {
  const calls = { inserts: [] as any[], updates: [] as any[] };
  const resolve = (state: any) => {
    const { table, op, selectOpts } = state;
    if (table === 'se_runs' && op === 'select') return { data: config.run ?? null, error: null };
    if (table === 'se_runs' && op === 'update') return { data: config.updateError ? null : (config.updateRaced ? [] : [{ id: 'run-1' }]), error: config.updateError ?? null };
    if (table === 'se_phases' && selectOpts?.head) return { count: config.attemptCount ?? 0, error: null };
    if (table === 'se_phases' && op === 'select') return { data: config.lastFailed ?? null, error: null };
    if (table === 'se_projects' && op === 'select') return { data: config.project ?? { approvers: [] }, error: null };
    if (table === 'se_run_prs' && op === 'select') return { data: config.prs ?? [], error: null };
    if (table === 'se_gates' && op === 'select') return { data: config.gate ?? null, error: null };
    return { data: null, error: null };
  };
  const from = (table: string) => {
    const state: any = { table, op: 'select', selectOpts: undefined };
    const b: any = {
      select(_s: unknown, opts: unknown) { state.selectOpts = opts; return b; },
      insert(row: unknown) { state.op = 'insert'; calls.inserts.push({ table, row }); return Promise.resolve({ data: null, error: null }); },
      update(row: unknown) { state.op = 'update'; calls.updates.push({ table, row }); return b; },
      eq() { return b; }, is() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve(resolve(state)); },
      single() { return Promise.resolve(resolve(state)); },
      then(onF: any, onR: any) { return Promise.resolve(resolve(state)).then(onF, onR); },
    };
    return b;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }), __calls: calls };
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
const failedRun = (over: any = {}) => ({
  id: RID, site_id: 'site-1', project_id: PID, status: 'failed', kind: 'issue',
  archived_at: null, current_phase: 'implement', error: 'agent produced no changes', ...over,
});

describe('POST /runs/:id/resume', () => {
  it('returns 409 when the atomic status guard loses the race (0 rows updated)', async () => {
    const { router } = mount(mockSupabase({ run: failedRun(), updateRaced: true }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('state_changed');
  });

  it('rejects a bad id with 400', async () => {
    const { router } = mount(mockSupabase());
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: 'nope' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('404s when the run is missing', async () => {
    const { router } = mount(mockSupabase({ run: null }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('409s when the run is not resumable (neither failed nor blocked)', async () => {
    const { router } = mount(mockSupabase({ run: failedRun({ status: 'running' }) }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('not_resumable');
  });

  it('409s when the run is archived', async () => {
    const { router } = mount(mockSupabase({ run: failedRun({ archived_at: '2026-01-01T00:00:00Z' }) }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('archived');
  });

  it('409s for an interactive session', async () => {
    const { router } = mount(mockSupabase({ run: failedRun({ kind: 'interactive' }) }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('not_resumable');
  });

  it('403s when the acting user is not an approver for a gated project', async () => {
    const { router } = mount(mockSupabase({
      run: failedRun(), project: { approvers: ['someone-else'] },
    }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID }, headers: {} }, res);
    expect(res.statusCode).toBe(403);
  });

  it('409s when neither the last-failed phase nor current_phase can resolve a phase', async () => {
    const { router } = mount(mockSupabase({ run: failedRun({ current_phase: null }), lastFailed: null }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('no_phase');
  });

  it('resumes from the latest FAILED se_phases row, incrementing the attempt', async () => {
    const { router, enqueued } = mount(mockSupabase({
      run: failedRun(),
      lastFailed: { phase: 'implement', attempt: 1 },
      attemptCount: 1,
    }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ resumed: true, phase: 'implement', attempt: 2 });
    expect(enqueued).toEqual([[
      'se', 'software-engineer:implement', { runId: RID, attempt: 2 },
      { jobId: `se-run-${RID}-implement`, removeOnComplete: true, removeOnFail: true },
    ]]);
  });

  it('falls back to run.current_phase when there is no failed se_phases row', async () => {
    const { router, enqueued } = mount(mockSupabase({
      run: failedRun({ current_phase: 'verify' }),
      lastFailed: null,
      attemptCount: 0,
    }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ resumed: true, phase: 'verify', attempt: 1 });
    expect(enqueued).toEqual([[
      'se', 'software-engineer:verify', { runId: RID, attempt: 1 },
      { jobId: `se-run-${RID}-verify`, removeOnComplete: true, removeOnFail: true },
    ]]);
  });

  it('inserts a system message describing the resume and the original failure', async () => {
    const supabase = mockSupabase({
      run: failedRun({ error: 'boom' }),
      lastFailed: { phase: 'implement', attempt: 1 },
      attemptCount: 1,
    });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(200);
    const msg = supabase.__calls.inserts.find((c: any) => c.table === 'se_messages');
    expect(msg).toBeTruthy();
    expect(msg.row.role).toBe('system');
    expect(msg.row.content).toContain('boom');
    expect(msg.row.content).toContain('attempt 2');
  });

  it('resumes a review_blocked run into the spec phase with objections threaded through', async () => {
    const supabase = mockSupabase({
      run: failedRun({ status: 'blocked', current_phase: 'review', error: 'adversarial review blocked (retries exhausted)', retry_count: 2 }),
      prs: [],
      gate: { detail: { objections: ['missing tests', 'wrong repo'] } },
      attemptCount: 0,
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ resumed: true, phase: 'spec', attempt: 1 });
    expect(enqueued).toEqual([[
      'se', 'software-engineer:spec', { runId: RID, attempt: 1, objections: ['missing tests', 'wrong repo'] },
      { jobId: `se-run-${RID}-spec`, removeOnComplete: true, removeOnFail: true },
    ]]);
    const msg = supabase.__calls.inserts.find((c: any) => c.table === 'se_messages');
    expect(msg.row.content).toContain('missing tests');
    expect(msg.row.content).toContain('wrong repo');
  });

  it('resumes a pr_closed_partial run into the revise phase', async () => {
    const supabase = mockSupabase({
      run: failedRun({ status: 'blocked', current_phase: 'watch', error: 'a PR was closed unmerged — partial; needs a human decision' }),
      prs: [{ state: 'closed_unmerged' }],
      attemptCount: 0,
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ resumed: true, phase: 'revise', attempt: 1 });
    expect(enqueued).toEqual([[
      'se', 'software-engineer:revise', { runId: RID, attempt: 1 },
      { jobId: `se-run-${RID}-revise`, removeOnComplete: true, removeOnFail: true },
    ]]);
    const msg = supabase.__calls.inserts.find((c: any) => c.table === 'se_messages');
    expect(msg.row.content).toContain('closed without merging');
  });

  it('resumes a config_blocked run into its current_phase as-is', async () => {
    const supabase = mockSupabase({
      run: failedRun({ status: 'blocked', current_phase: 'implement', error: 'intake disabled' }),
      prs: [],
      attemptCount: 1,
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ resumed: true, phase: 'implement', attempt: 2 });
    expect(enqueued).toEqual([[
      'se', 'software-engineer:implement', { runId: RID, attempt: 2 },
      { jobId: `se-run-${RID}-implement`, removeOnComplete: true, removeOnFail: true },
    ]]);
    const msg = supabase.__calls.inserts.find((c: any) => c.table === 'se_messages');
    expect(msg.row.content).toContain('intake disabled');
  });

  it('500s when the atomic status-guarded update fails', async () => {
    const { router } = mount(mockSupabase({
      run: failedRun(),
      lastFailed: { phase: 'implement', attempt: 1 },
      attemptCount: 1,
      updateError: { message: 'db down' },
    }));
    const res = mockRes();
    await router.handler('POST /runs/:id/resume')({ params: { id: RID } }, res);
    expect(res.statusCode).toBe(500);
  });
});
