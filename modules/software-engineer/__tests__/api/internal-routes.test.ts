// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises the reporter-feedback internal API's auth gate and its two write paths' validation. These
// routes are mounted under `/internal/` (bypasses the platform's user-JWT gate) so the x-gatewaze-
// internal-key check IS the only thing standing between the public internet and this module's reporter
// data — every test here is really a test of that gate plus the handlers' own input validation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mountReporterRoutes } from '../../api/internal-routes.js';

const KEY = 'test-service-role-key';

function recorderRouter() {
  const middlewares = [];
  const routes = new Map();
  return {
    use(fn) { middlewares.push(fn); },
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers[handlers.length - 1]); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers[handlers.length - 1]); },
    async dispatch(method, path, req) {
      const res = { statusCode: 200, body: undefined, status(s) { res.statusCode = s; return res; }, json(b) { res.body = b; return res; } };
      let shortCircuited = false;
      for (const mw of middlewares) {
        let calledNext = false;
        await mw(req, res, () => { calledNext = true; });
        if (!calledNext) { shortCircuited = true; break; }
      }
      if (!shortCircuited) {
        const handler = routes.get(`${method} ${path}`);
        if (!handler) throw new Error(`no route for ${method} ${path}`);
        await handler(req, res);
      }
      return res;
    },
  };
}

function mockSupabase(config = {}) {
  const inserts = [];
  const from = (table) => {
    const api = {
      select() { return api; },
      insert(row) { inserts.push({ table, row }); return api; },
      upsert(row) { inserts.push({ table, row, upsert: true }); return api; },
      update(row) { api.__update = row; return api; },
      eq() { return api; },
      in() { return api; },
      maybeSingle() {
        if (table === 'se_runs') return Promise.resolve({ data: config.run ?? { id: 'run-1', site_id: 'site-1' }, error: null });
        if (table === 'se_reporter_questions') return Promise.resolve({ data: config.question ?? null, error: null });
        if (table === 'se_reporter_answers') return Promise.resolve({ data: config.existingAnswer ?? null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        return Promise.resolve({ data: { id: 'row-1', ...api.__update }, error: null });
      },
    };
    return api;
  };
  return { from, __inserts: inserts };
}

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PERSON_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const REPORT_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('reporter-feedback internal API', () => {
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  beforeEach(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = KEY; });
  afterEach(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey; });

  function mount(supabase) {
    const router = recorderRouter();
    mountReporterRoutes(router, { supabase, logger: { error() {} } });
    return router;
  }

  it('rejects any request missing the internal key with 401', async () => {
    const router = mount(mockSupabase());
    const res = await router.dispatch('POST', '/reporter-links', { headers: {}, body: {} });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with a wrong internal key with 401', async () => {
    const router = mount(mockSupabase());
    const res = await router.dispatch('POST', '/reporter-links', { headers: { 'x-gatewaze-internal-key': 'wrong' }, body: {} });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a correctly-keyed reporter-links write and rejects malformed ids', async () => {
    const router = mount(mockSupabase());
    const bad = await router.dispatch('POST', '/reporter-links', {
      headers: { 'x-gatewaze-internal-key': KEY },
      body: { runId: 'not-a-uuid', externalSystem: 'health_core', externalReportId: REPORT_ID, externalPersonId: PERSON_ID },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await router.dispatch('POST', '/reporter-links', {
      headers: { 'x-gatewaze-internal-key': KEY },
      body: { runId: RUN_ID, externalSystem: 'health_core', externalReportId: REPORT_ID, externalPersonId: PERSON_ID },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('rejects an unknown externalSystem', async () => {
    const router = mount(mockSupabase());
    const res = await router.dispatch('POST', '/reporter-links', {
      headers: { 'x-gatewaze-internal-key': KEY },
      body: { runId: RUN_ID, externalSystem: 'sms', externalReportId: REPORT_ID, externalPersonId: PERSON_ID },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 stale_question from /reporter-answers when the question is not pending', async () => {
    const QID = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';
    const supabase = mockSupabase({ question: { id: QID, status: 'superseded', revision: 2, run_id: RUN_ID, kind: 'text' } });
    const router = mount(supabase);
    const res = await router.dispatch('POST', '/reporter-answers', {
      headers: { 'x-gatewaze-internal-key': KEY },
      body: { questionId: QID, revision: 1, answer: { text: 'too late' }, idempotencyKey: 'k1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('already_answered');
  });

  it('validates required fields on /reporter-answers', async () => {
    const router = mount(mockSupabase());
    const res = await router.dispatch('POST', '/reporter-answers', {
      headers: { 'x-gatewaze-internal-key': KEY },
      body: { questionId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validates externalPersonIds on /reporter-questions', async () => {
    const router = mount(mockSupabase());
    const res = await router.dispatch('GET', '/reporter-questions', {
      headers: { 'x-gatewaze-internal-key': KEY },
      query: { externalSystem: 'health_core', externalPersonIds: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});
