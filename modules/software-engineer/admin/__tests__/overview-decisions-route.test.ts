// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises GET /overview/decisions (issue #49): it must gather every run parked on a human across
// the human-gated statuses, join se_run_prs to disambiguate `blocked` into pr_closed_partial vs
// review_blocked vs config_blocked, and classify+label each row without an N+1 (one se_run_prs query
// and one se_gates query for the whole page, not one per run).
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

// Records every .from(table) call so the test can assert there's exactly one se_run_prs query and one
// se_gates query for the whole page (no per-run fan-out).
function mockSupabase({ runs = [], runsError = null, prs = [], gates = [] }: any = {}) {
  const fromCalls: string[] = [];
  const from = (table: string) => {
    fromCalls.push(table);
    const resolveFor = () => {
      if (table === 'se_runs') return { data: runs, error: runsError };
      if (table === 'se_run_prs') return { data: prs, error: null };
      if (table === 'se_gates') return { data: gates, error: null };
      return { data: [], error: null };
    };
    const b: any = {
      select() { return b; },
      is() { return b; }, in() { return b; }, eq() { return b; }, order() { return b; }, limit() { return b; },
      then(resolve: any, reject: any) { return Promise.resolve(resolveFor()).then(resolve, reject); },
    };
    return b;
  };
  return { from, fromCalls };
}

function mount(supabase: unknown) {
  const router = recorderRouter();
  mountAdminRoutes(router as never, { supabase, getRedis: () => null, logger: { warn() {}, info() {} }, enqueueJob: async () => {} });
  return router;
}

describe('GET /overview/decisions', () => {
  it('returns an empty page with count 0 when nothing is gated', async () => {
    const supabase = mockSupabase({ runs: [] });
    const router = mount(supabase);
    const res = mockRes();
    await router.handler('GET /overview/decisions')({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ decisions: [], count: 0 });
  });

  it('classifies a mixed page of runs and joins se_run_prs correctly, one row per gated run', async () => {
    const runs = [
      { id: 'r1', status: 'awaiting_spec', retry_count: 0 },
      { id: 'r2', status: 'awaiting_architecture', retry_count: 0 },
      { id: 'r3', status: 'ready_to_submit', retry_count: 0 },
      { id: 'r4', status: 'blocked', error: 'adversarial review blocked (retries exhausted)', retry_count: 2 },
      { id: 'r5', status: 'blocked', error: 'a PR was closed unmerged — partial; needs a human decision', retry_count: 0 },
      { id: 'r6', status: 'blocked', error: 'intake disabled', retry_count: 0 },
      { id: 'r7', status: 'running' }, // shouldn't be selected in a real query, but pins the filter-out too
    ];
    const prs = [{ run_id: 'r5', state: 'closed_unmerged' }, { run_id: 'r3', state: 'open' }];
    const gates = [{ run_id: 'r4', detail: { objections: ['missing tests'] }, created_at: '2026-01-02T00:00:00Z' }];
    const supabase = mockSupabase({ runs, prs, gates });
    const router = mount(supabase);
    const res = mockRes();
    await router.handler('GET /overview/decisions')({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(6);
    const byId = Object.fromEntries(res.body.decisions.map((d: any) => [d.id, d]));
    expect(byId.r1.kind).toBe('awaiting_spec');
    expect(byId.r2.kind).toBe('awaiting_architecture');
    expect(byId.r3.kind).toBe('ready_to_submit');
    expect(byId.r4.kind).toBe('review_blocked');
    expect(byId.r4.decision).toContain('2 revisions');
    expect(byId.r4.objections).toEqual(['missing tests']);
    expect(byId.r5.kind).toBe('pr_closed_partial');
    expect(byId.r6.kind).toBe('config_blocked');
    expect(byId.r6.decision).toBe('intake disabled');
    expect(byId.r7).toBeUndefined();
    // No N+1: exactly one se_run_prs query and one se_gates query for the whole page.
    expect(supabase.fromCalls.filter((t) => t === 'se_run_prs')).toHaveLength(1);
    expect(supabase.fromCalls.filter((t) => t === 'se_gates')).toHaveLength(1);
  });

  it('rejects a malformed ?project with 400 and never hits the DB', async () => {
    const supabase = mockSupabase({ runs: [] });
    const router = mount(supabase);
    const res = mockRes();
    await router.handler('GET /overview/decisions')({ query: { project: 'nope' } }, res);
    expect(res.statusCode).toBe(400);
    expect(supabase.fromCalls).toHaveLength(0);
  });

  it('returns 500 when the run query errors', async () => {
    const supabase = mockSupabase({ runs: [], runsError: { message: 'db down' } });
    const router = mount(supabase);
    const res = mockRes();
    await router.handler('GET /overview/decisions')({ query: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
