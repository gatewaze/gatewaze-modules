// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises POST /decisions/:id/answer (issue #52): the interactive counterpart of the Decisions
// panel. Reuses resumeRunForDecision/approveArchitecture (see lib/__tests__/decisions.test.ts for
// their own unit coverage) so this file focuses on the route's own validation, CAS-guard, branching
// by origin (architecture vs review_blocked vs pr_closed_partial vs not-answerable config_blocked),
// and the rollback-on-action-failure behavior.
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

function mockSupabase(config: any = {}) {
  const calls = { inserts: [] as any[], updates: [] as any[] };
  const resolve = (state: any) => {
    const { table, op, selectOpts } = state;
    if (table === 'se_decisions' && op === 'select') return { data: config.decision ?? null, error: null };
    if (table === 'se_decisions' && op === 'update') {
      return { data: config.decisionUpdateError ? null : (config.decisionRaced ? null : { ...config.decision, status: 'answered' }), error: config.decisionUpdateError ?? null };
    }
    if (table === 'se_runs' && op === 'select') return { data: config.run ?? null, error: null };
    if (table === 'se_runs' && op === 'update') {
      return { data: config.runUpdateError ? null : (config.runUpdateRaced ? [] : [{ id: 'run-1' }]), error: config.runUpdateError ?? null };
    }
    if (table === 'se_phases' && selectOpts?.head) return { count: config.attemptCount ?? 0, error: null };
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

const RID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

const textDecision = (over: any = {}) => ({ id: DID, run_id: RID, status: 'pending', kind: 'text', question: 'q?', options: null, ...over });
const choiceDecision = (over: any = {}) => ({
  id: DID, run_id: RID, status: 'pending', kind: 'choice', question: 'Architecture proposal ready',
  options: [{ id: 'approve', label: 'Approve' }, { id: 'request_changes', label: 'Request changes' }, { id: 'reject', label: 'Reject' }],
  ...over,
});
const run = (over: any = {}) => ({ id: RID, site_id: 'site-1', project_id: 'proj-1', status: 'blocked', current_phase: 'review', archived_at: null, ...over });

describe('POST /decisions/:id/answer', () => {
  it('rejects a bad id with 400', async () => {
    const { router } = mount(mockSupabase());
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: 'nope' }, headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('404s when the decision is missing', async () => {
    const { router } = mount(mockSupabase({ decision: null }));
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  it('409s when the decision was already answered', async () => {
    const { router } = mount(mockSupabase({ decision: textDecision({ status: 'answered' }) }));
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { text: 'x' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('already_answered');
  });

  it('404s when the run backing the decision is missing', async () => {
    const { router } = mount(mockSupabase({ decision: textDecision(), run: null }));
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { text: 'x' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('403s when the acting user is not an approver for a gated project', async () => {
    const supabase = mockSupabase({ decision: textDecision(), run: run(), project: { approvers: ['someone-else'] } });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { text: 'x' } }, res);
    expect(res.statusCode).toBe(403);
  });

  it('400s a choice answer with an option_id that does not match the decision options', async () => {
    const supabase = mockSupabase({ decision: choiceDecision(), run: run({ status: 'architecture_in_review' }) });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { option_id: 'nonsense' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_option');
  });

  it('400s a text answer with empty text', async () => {
    const supabase = mockSupabase({ decision: textDecision(), run: run() });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { text: '   ' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('empty_answer');
  });

  it('400s an architecture request_changes answer with no text', async () => {
    const supabase = mockSupabase({ decision: choiceDecision(), run: run({ status: 'architecture_in_review' }) });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { option_id: 'request_changes' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('empty_answer');
  });

  it('400s not_answerable when the origin classifies as config_blocked', async () => {
    const supabase = mockSupabase({
      decision: textDecision(), run: run({ error: 'intake disabled' }), prs: [],
    });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { text: 'please resume' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('not_answerable');
  });

  it('409s when the decision CAS-update loses the race', async () => {
    const supabase = mockSupabase({
      decision: textDecision(), run: run({ error: 'adversarial review blocked (retries exhausted)' }), prs: [], decisionRaced: true,
    });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { text: 'go' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('already_answered');
  });

  it('resumes a review_blocked run into spec, threading gate objections through', async () => {
    const supabase = mockSupabase({
      decision: textDecision(),
      run: run({ error: 'adversarial review blocked (retries exhausted)' }),
      prs: [],
      gate: { detail: { objections: ['missing tests'] } },
      attemptCount: 0,
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { text: 'enrich the issue' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.decision.status).toBe('answered');
    expect(enqueued).toEqual([[
      'se', 'software-engineer:spec', { runId: RID, attempt: 1, objections: ['missing tests'] },
      { jobId: `se-run-${RID}-spec`, removeOnComplete: true, removeOnFail: true },
    ]]);
  });

  it('threads the chosen option label into the resume note for a distilled choice-kind review_blocked decision', async () => {
    // distillDecision() (workers/review.ts) can emit kind:'choice' with custom option ids for a
    // review_blocked origin, not just the fixed architecture options — regression for the bug where
    // an option pick with no free text produced an empty "Answered by admin: " note.
    const decision = choiceDecision({
      question: 'How should the run proceed?',
      options: [{ id: 'enrich_issue', label: 'Enrich the issue' }, { id: 'retry', label: 'Retry as-is' }],
    });
    const supabase = mockSupabase({
      decision, run: run({ error: 'adversarial review blocked (retries exhausted)' }),
      prs: [], gate: { detail: { objections: ['missing tests'] } }, attemptCount: 0,
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { option_id: 'enrich_issue' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.decision.status).toBe('answered');
    const msg = supabase.__calls.inserts.find((c: any) => c.table === 'se_messages');
    expect(msg.row.content).toContain('Enrich the issue');
    expect(msg.row.content).not.toContain('Answered by admin: —');
  });

  it('resumes a pr_closed_partial run into revise', async () => {
    const supabase = mockSupabase({
      decision: textDecision(), run: run({ current_phase: 'watch', error: 'closed unmerged' }),
      prs: [{ state: 'closed_unmerged' }], attemptCount: 0,
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { text: 'try again' } }, res);
    expect(res.statusCode).toBe(200);
    expect(enqueued).toEqual([[
      'se', 'software-engineer:revise', { runId: RID, attempt: 1 },
      { jobId: `se-run-${RID}-revise`, removeOnComplete: true, removeOnFail: true },
    ]]);
  });

  it('approves an architecture proposal and enqueues implement', async () => {
    const supabase = mockSupabase({
      decision: choiceDecision(), run: run({ status: 'architecture_in_review' }),
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { option_id: 'approve' } }, res);
    expect(res.statusCode).toBe(200);
    expect(enqueued).toEqual([[
      'se', 'software-engineer:implement', { runId: RID },
      { jobId: `se-run-${RID}-implement`, removeOnComplete: true, removeOnFail: true },
    ]]);
  });

  it('409s an architecture approve when the run has not been finalized yet', async () => {
    const supabase = mockSupabase({
      decision: choiceDecision(), run: run({ status: 'awaiting_architecture' }),
    });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { option_id: 'approve' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('not_finalized');
    // The decision must roll back to pending — the approve didn't take effect.
    const rollback = supabase.__calls.updates.find((c: any) => c.table === 'se_decisions' && c.row.status === 'pending');
    expect(rollback).toBeTruthy();
  });

  it('rejects an architecture proposal, moving the run to blocked with the reason', async () => {
    const supabase = mockSupabase({
      decision: choiceDecision(), run: run({ status: 'architecture_in_review' }),
    });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { option_id: 'reject', text: 'wrong approach' } }, res);
    expect(res.statusCode).toBe(200);
    const runUpdate = supabase.__calls.updates.find((c: any) => c.table === 'se_runs' && c.row.status === 'blocked');
    expect(runUpdate.row.error).toContain('wrong approach');
  });

  it('requests changes on an architecture proposal, resuming into the architecture phase', async () => {
    const supabase = mockSupabase({
      decision: choiceDecision(), run: run({ status: 'architecture_in_review' }), attemptCount: 0,
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /decisions/:id/answer')({ params: { id: DID }, headers: {}, body: { option_id: 'request_changes', text: 'add error handling' } }, res);
    expect(res.statusCode).toBe(200);
    expect(enqueued).toEqual([[
      'se', 'software-engineer:architecture', { runId: RID, attempt: 1 },
      { jobId: `se-run-${RID}-architecture`, removeOnComplete: true, removeOnFail: true },
    ]]);
  });
});
