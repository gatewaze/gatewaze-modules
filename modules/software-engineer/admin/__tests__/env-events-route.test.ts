// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// GET /test-env/env-events — the log explorer's only endpoint, in both modes.
// What matters here is the SHAPE OF THE QUERY the route builds, because that is
// what stops the table from being read unboundedly and what keeps caller input
// out of PostgREST filter expressions. The supabase double therefore records
// every filter call rather than just returning rows.
//
// Covered: env / kind / time / search filters, the `none` (unattributed) leg,
// keyset paging with the extra-row has_more probe, the page-size cap, the
// summary mode's scan cap, and a refusal for every malformed parameter.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: () => false,          // no multi-env channel — env-events does not need one
  readFileSync: () => { throw new Error('ENOENT'); },
  writeFileSync: () => {},
  readdirSync: () => [],
  statSync: () => { throw new Error('ENOENT'); },
}));

import { mountAdminRoutes } from '../../api/admin-routes.js';
import { SUMMARY_SCAN_CAP } from '../../lib/env-events-query.js';

function recorderRouter() {
  const routes = new Map();
  const add = (method) => (path, ...handlers) => { routes.set(`${method} ${path}`, handlers[handlers.length - 1]); };
  return {
    use: () => {},
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    handler: (key) => routes.get(key),
  };
}

function mockRes() {
  const res = {
    statusCode: 200, body: undefined,
    status(s) { res.statusCode = s; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}

/** Chainable supabase double that records the filter chain it was handed. */
function mockSupabase(rows = []) {
  const calls = [];
  const b = {
    select(...a) { calls.push(['select', ...a]); return b; },
    eq(...a) { calls.push(['eq', ...a]); return b; },
    in(...a) { calls.push(['in', ...a]); return b; },
    is(...a) { calls.push(['is', ...a]); return b; },
    or(...a) { calls.push(['or', ...a]); return b; },
    gte(...a) { calls.push(['gte', ...a]); return b; },
    lte(...a) { calls.push(['lte', ...a]); return b; },
    ilike(...a) { calls.push(['ilike', ...a]); return b; },
    order(...a) { calls.push(['order', ...a]); return b; },
    limit(n) { calls.push(['limit', n]); return Promise.resolve({ data: rows, error: null }); },
    maybeSingle() { return Promise.resolve({ data: { role: 'super_admin' }, error: null }); },
    insert() { return Promise.resolve({ data: null, error: null }); },
    upsert() { return Promise.resolve({ data: null, error: null }); },
    delete() { return b; },
    lt(...a) { calls.push(['lt', ...a]); return Promise.resolve({ data: null, error: null }); },
  };
  return { from: () => b, rpc: () => Promise.resolve({ data: null, error: null }), _calls: calls };
}

let ipSeq = 0;
const call = async (supabase, query) => {
  const router = recorderRouter();
  mountAdminRoutes(router, { supabase, getRedis: () => null, logger: { warn() {}, info() {} }, enqueueJob: async () => ({}) });
  const res = mockRes();
  await router.handler('GET /test-env/env-events')(
    { ip: `10.9.0.${++ipSeq}`, query, params: {}, body: {}, headers: { authorization: 'Bearer t' }, userId: 'u1' },
    res,
  );
  return res;
};
const find = (calls, name) => calls.filter(([n]) => n === name);

const row = (id, ts, over = {}) => ({ id, ts, kind: 'visit', env_label: 'lfx--a1', detail: 'd', meta: null, ...over });

beforeEach(() => { ipSeq += 1000; });

describe('paging', () => {
  it('orders newest-first on (ts, id) and asks for one row more than the page', async () => {
    const sb = mockSupabase([]);
    await call(sb, { limit: '25' });
    expect(find(sb._calls, 'order').map(([, col, opt]) => [col, opt.ascending]))
      .toEqual([['ts', false], ['id', false]]);
    expect(find(sb._calls, 'limit')).toEqual([['limit', 26]]);
  });

  it('reports has_more + a keyset cursor built from the LAST returned row', async () => {
    const rows = [row(9, '2026-08-23T10:03:00Z'), row(8, '2026-08-23T10:02:00Z'), row(7, '2026-08-23T10:01:00Z')];
    const res = await call(mockSupabase(rows), { limit: '2' });
    expect(res.body.events.map((e) => e.id)).toEqual([9, 8]);   // the probe row is trimmed
    expect(res.body.has_more).toBe(true);
    expect(res.body.next_cursor).toEqual({ before_ts: '2026-08-23T10:02:00Z', before_id: 8 });
  });

  it('reports the end of the log with no cursor', async () => {
    const res = await call(mockSupabase([row(9, '2026-08-23T10:03:00Z')]), { limit: '2' });
    expect(res.body.has_more).toBe(false);
    expect(res.body.next_cursor).toBeNull();
  });

  it('turns a cursor into a (ts, id) keyset predicate with OUR re-serialised values', async () => {
    const sb = mockSupabase([]);
    await call(sb, { before_ts: '2026-08-23T10:02:00Z', before_id: '8' });
    expect(find(sb._calls, 'or')).toEqual([[
      'or', 'ts.lt.2026-08-23T10:02:00.000Z,and(ts.eq.2026-08-23T10:02:00.000Z,id.lt.8)',
    ]]);
  });

  it('keeps the env leg and the cursor leg as two separate .or() predicates', async () => {
    // PostgREST ANDs repeated top-level params, so two .or() calls mean
    // (env matches OR unattributed) AND (cursor boundary). Merging them into
    // one .or() would silently widen the page to everything older OR in the
    // env set — this test exists to make that refactor fail loudly.
    const sb = mockSupabase([]);
    await call(sb, { env: 'lfx--a1,none', before_ts: '2026-08-23T10:02:00Z', before_id: '8' });
    expect(find(sb._calls, 'or').map(([, f]) => f)).toEqual([
      'env_label.is.null,env_label.in.(lfx--a1)',
      'ts.lt.2026-08-23T10:02:00.000Z,and(ts.eq.2026-08-23T10:02:00.000Z,id.lt.8)',
    ]);
  });

  it('caps the page size', async () => {
    expect((await call(mockSupabase([]), { limit: '5000' })).statusCode).toBe(422);
    const sb = mockSupabase([]);
    await call(sb, {});
    expect(find(sb._calls, 'limit')).toEqual([['limit', 101]]);  // default 100 + the probe row
  });
});

describe('filters', () => {
  it('applies a multi-env selection as an .in() list', async () => {
    const sb = mockSupabase([]);
    await call(sb, { env: 'lfx--a1,lfx--b2' });
    expect(find(sb._calls, 'in')).toEqual([['in', 'env_label', ['lfx--a1', 'lfx--b2']]]);
    expect(find(sb._calls, 'or')).toEqual([]);
  });

  it('selects only the unattributed events with env=none', async () => {
    const sb = mockSupabase([]);
    await call(sb, { env: 'none' });
    expect(find(sb._calls, 'is')).toEqual([['is', 'env_label', null]]);
  });

  it('combines envs + unattributed into one .or() built from validated labels', async () => {
    const sb = mockSupabase([]);
    await call(sb, { env: 'lfx--a1,none' });
    expect(find(sb._calls, 'or')).toEqual([['or', 'env_label.is.null,env_label.in.(lfx--a1)']]);
  });

  it('applies kind, window and search', async () => {
    const sb = mockSupabase([]);
    await call(sb, { kind: 'visit,service_error', since: '2026-08-23T10:00:00Z', until: '2026-08-23T11:00:00Z', q: 'newsletter' });
    expect(find(sb._calls, 'in')).toEqual([['in', 'kind', ['visit', 'service_error']]]);
    expect(find(sb._calls, 'gte')).toEqual([['gte', 'ts', '2026-08-23T10:00:00.000Z']]);
    expect(find(sb._calls, 'lte')).toEqual([['lte', 'ts', '2026-08-23T11:00:00.000Z']]);
    expect(find(sb._calls, 'ilike')).toEqual([['ilike', 'detail', '%newsletter%']]);
  });

  it('sanitises the search term before it becomes an ilike pattern', async () => {
    const sb = mockSupabase([]);
    await call(sb, { q: "%,or(id.gt.0)%" });
    const [[, col, pattern]] = find(sb._calls, 'ilike');
    expect(col).toBe('detail');
    // The only % left are the ones WE added as the contains-wildcards.
    expect(pattern).toBe('%or id gt 0%');
    for (const ch of ['*', '\\', '(', ')', ',']) expect(pattern).not.toContain(ch);
  });

  it('refuses every malformed parameter with a 422 and no query', async () => {
    for (const query of [
      { env: 'lfx--a),x.in.(y' },
      { env: 'DROP' },
      { kind: 'visit,DROP TABLE' },
      { since: 'yesterday' },
      { limit: '0' },
      { buckets: '9999' },
      { before_ts: '2026-08-23T10:00:00Z' },
      { before_ts: '2026-08-23T10:00:00Z', before_id: '1,ts.gt.2000' },
    ]) {
      const sb = mockSupabase([]);
      const res = await call(sb, query);
      expect(res.statusCode, JSON.stringify(query)).toBe(422);
      expect(res.body.error.code).toBe('invalid_input');
      expect(find(sb._calls, 'limit'), JSON.stringify(query)).toEqual([]);
    }
  });
});

describe('summary mode', () => {
  it('scans a bounded window with a hard cap and returns the rollup', async () => {
    const sb = mockSupabase([
      { ts: '2026-08-23T10:05:00Z', kind: 'visit', env_label: 'lfx--a1' },
      { ts: '2026-08-23T10:06:00Z', kind: 'service_error', env_label: 'lfx--a1' },
    ]);
    const res = await call(sb, { summary: '1', since: '2026-08-23T10:00:00Z', until: '2026-08-23T11:00:00Z', buckets: '4' });
    expect(find(sb._calls, 'limit')).toEqual([['limit', SUMMARY_SCAN_CAP + 1]]);
    expect(find(sb._calls, 'select')).toEqual([['select', 'ts, kind, env_label']]);
    expect(res.body.summary.totals).toMatchObject({ visits: 1, errors: 1, total: 2 });
    expect(res.body.summary.sparkline).toHaveLength(4);
    expect(res.body.summary.truncated).toBe(false);
    expect(res.body.summary.window).toEqual({ from: '2026-08-23T10:00:00.000Z', to: '2026-08-23T11:00:00.000Z' });
  });

  it('bounds an unbounded request to the last hour rather than scanning everything', async () => {
    const sb = mockSupabase([]);
    await call(sb, { summary: '1' });
    const [[, , from], [, , to]] = [...find(sb._calls, 'gte'), ...find(sb._calls, 'lte')];
    expect(Date.parse(to) - Date.parse(from)).toBe(3_600_000);
  });

  it('flags the scan cap so the UI can say the counts are a floor', async () => {
    const many = Array.from({ length: SUMMARY_SCAN_CAP + 1 }, (_, i) => ({
      ts: '2026-08-23T10:05:00Z', kind: 'visit', env_label: 'lfx--a1', _i: i,
    }));
    const res = await call(mockSupabase(many), { summary: '1', since: '2026-08-23T10:00:00Z', until: '2026-08-23T11:00:00Z' });
    expect(res.body.summary.truncated).toBe(true);
    expect(res.body.summary.total).toBe(SUMMARY_SCAN_CAP);
  });
});
