// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises POST /runs/:id/message, in particular its issue #49 §6 extension: a `blocked` run is
// agent-discussable (message stored, no refine job enqueued — it sits in the mailbox for the next
// Resume) UNLESS it's `config_blocked` (authorization/kill_switch), which still 409s.
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
  const calls = { inserts: [] as any[] };
  const resolve = (table: string) => {
    if (table === 'se_runs') return { data: config.run ?? null, error: null };
    if (table === 'se_run_prs') return { data: config.prs ?? [], error: null };
    return { data: null, error: null };
  };
  const from = (table: string) => {
    const b: any = {
      select() { return b; },
      insert(row: unknown) { calls.inserts.push({ table, row }); return Promise.resolve({ data: null, error: null }); },
      eq() { return b; }, is() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve(resolve(table)); },
      then(onF: any, onR: any) { return Promise.resolve(resolve(table)).then(onF, onR); },
    };
    return b;
  };
  return { from, __calls: calls };
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
const body = { params: { id: RID }, body: { content: 'hello' } };

describe('POST /runs/:id/message', () => {
  it('404s when the run is missing', async () => {
    const { router } = mount(mockSupabase({ run: null }));
    const res = mockRes();
    await router.handler('POST /runs/:id/message')(body, res);
    expect(res.statusCode).toBe(404);
  });

  it('409s for a config_blocked run and does not store the message', async () => {
    const supabase = mockSupabase({ run: { id: RID, site_id: 's1', status: 'blocked', error: 'intake disabled' }, prs: [] });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /runs/:id/message')(body, res);
    expect(res.statusCode).toBe(409);
    expect(supabase.__calls.inserts).toHaveLength(0);
  });

  it('accepts a message on a review_blocked run without enqueuing a refine job', async () => {
    const supabase = mockSupabase({
      run: { id: RID, site_id: 's1', status: 'blocked', error: 'adversarial review blocked (retries exhausted)', retry_count: 2 },
      prs: [],
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /runs/:id/message')(body, res);
    expect(res.statusCode).toBe(202);
    const msg = supabase.__calls.inserts.find((c: any) => c.table === 'se_messages');
    expect(msg).toBeTruthy();
    expect(msg.row.role).toBe('admin');
    expect(msg.row.content).toBe('hello');
    expect(enqueued).toHaveLength(0);
  });

  it('accepts a message on a pr_closed_partial run without enqueuing a refine job', async () => {
    const supabase = mockSupabase({
      run: { id: RID, site_id: 's1', status: 'blocked', error: 'a PR was closed unmerged — partial; needs a human decision' },
      prs: [{ state: 'closed_unmerged' }],
    });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /runs/:id/message')(body, res);
    expect(res.statusCode).toBe(202);
    expect(supabase.__calls.inserts.find((c: any) => c.table === 'se_messages')).toBeTruthy();
    expect(enqueued).toHaveLength(0);
  });

  it('still enqueues the spec-refine job for an awaiting_spec run (unchanged behavior)', async () => {
    const supabase = mockSupabase({ run: { id: RID, site_id: 's1', status: 'awaiting_spec' } });
    const { router, enqueued } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /runs/:id/message')(body, res);
    expect(res.statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0][1]).toBe('software-engineer:spec-refine');
  });

  it('409s for a live-unrelated status that is neither gated nor blocked-discussable', async () => {
    const supabase = mockSupabase({ run: { id: RID, site_id: 's1', status: 'merged' } });
    const { router } = mount(supabase);
    const res = mockRes();
    await router.handler('POST /runs/:id/message')(body, res);
    expect(res.statusCode).toBe(409);
  });
});
