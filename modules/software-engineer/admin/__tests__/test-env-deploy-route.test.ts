// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises POST /test-env/deploy: PR-set validation per profile, and the mainline
// (plain origin/main, no PRs) escape hatch — an EMPTY prs list is accepted ONLY with
// an explicit `mainline: true` boolean, for BOTH profiles, and the request file
// written for the host agent carries the empty prs list verbatim. An empty list
// without the flag (or with a non-boolean flag) must still 422 so an accidentally
// empty selection can never replace the env.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// node:fs double — only api/admin-routes.ts imports node:fs in this module graph.
// existsSync: the control dir exists, no request/processing files pending.
// readFileSync: no status file yet (throws, like the real ENOENT path).
// writeFileSync: records every request file the route writes for the host agent.
const fs = vi.hoisted(() => ({ writes: [] as Array<[string, any]> }));
vi.mock('node:fs', () => ({
  existsSync: (p: string) => p === '/staging-control',
  readFileSync: () => { throw new Error('ENOENT'); },
  writeFileSync: (p: string, body: string) => { fs.writes.push([p, JSON.parse(body)]); },
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

// Chainable supabase double: the route's super-admin escalation reads admin_profiles.
function mockSupabase(role = 'super_admin') {
  const from = (table: string) => {
    const b: any = {
      select() { return b; }, eq() { return b; }, is() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() {
        return Promise.resolve({ data: table === 'admin_profiles' ? { role } : null, error: null });
      },
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
  return router.handler('POST /test-env/deploy');
}

// Unique per-test IP so the in-memory rate limiter never couples tests.
let ipSeq = 0;
const request = (body: any) => ({
  ip: `10.1.0.${++ipSeq}`, query: {}, body,
  headers: { authorization: 'Bearer test-token' },
  userId: 'user-1',
});

describe('POST /test-env/deploy', () => {
  beforeEach(() => { fs.writes.length = 0; });

  it('rejects an empty prs list WITHOUT the mainline flag (gatewaze) with 422', async () => {
    const handler = mount(mockSupabase());
    const res = mockRes();
    await handler(request({ profile: 'gatewaze', prs: [] }), res);
    expect(res.statusCode).toBe(422);
    expect(fs.writes).toEqual([]);
  });

  it('rejects an empty prs list WITHOUT the mainline flag (lfx) with 422', async () => {
    const handler = mount(mockSupabase());
    const res = mockRes();
    await handler(request({ profile: 'lfx', prs: [] }), res);
    expect(res.statusCode).toBe(422);
    expect(fs.writes).toEqual([]);
  });

  it('rejects a non-boolean mainline flag with an empty prs list (strict === true)', async () => {
    const handler = mount(mockSupabase());
    const res = mockRes();
    await handler(request({ profile: 'gatewaze', prs: [], mainline: 'true' }), res);
    expect(res.statusCode).toBe(422);
    expect(fs.writes).toEqual([]);
  });

  it('accepts mainline: true with empty prs for the gatewaze profile and forwards prs: []', async () => {
    const handler = mount(mockSupabase());
    const res = mockRes();
    await handler(request({ profile: 'gatewaze', prs: [], mainline: true }), res);
    expect(res.statusCode).toBe(202);
    expect(fs.writes).toHaveLength(1);
    const [path, payload] = fs.writes[0];
    expect(path).toBe('/staging-control/test-env-request.json');
    expect(payload.action).toBe('deploy');
    expect(payload.prs).toEqual([]);
    expect(payload.requested_by).toBe('user-1');
  });

  it('accepts mainline: true with empty prs for the lfx profile and writes the lfx request file', async () => {
    const handler = mount(mockSupabase());
    const res = mockRes();
    await handler(request({ profile: 'lfx', prs: [], mainline: true }), res);
    expect(res.statusCode).toBe(202);
    expect(fs.writes).toHaveLength(1);
    const [path, payload] = fs.writes[0];
    expect(path).toBe('/staging-control/lfx-env-request.json');
    expect(payload.action).toBe('deploy');
    expect(payload.prs).toEqual([]);
  });

  it('still accepts a non-empty prs list without the flag (unchanged behavior)', async () => {
    const handler = mount(mockSupabase());
    const res = mockRes();
    await handler(request({ profile: 'gatewaze', prs: [{ repo: 'gatewaze-modules', number: 7 }] }), res);
    expect(res.statusCode).toBe(202);
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0][1].prs).toEqual([{ repo: 'gatewaze-modules', number: 7 }]);
  });

  it('validates a non-empty prs list exactly as before even when mainline: true is set', async () => {
    const handler = mount(mockSupabase());
    const res = mockRes();
    await handler(request({ profile: 'gatewaze', prs: [{ repo: 'not-allowed', number: 7 }], mainline: true }), res);
    expect(res.statusCode).toBe(422);
    expect(fs.writes).toEqual([]);
  });

  it('mainline does not bypass the super-admin escalation', async () => {
    const handler = mount(mockSupabase('admin'));
    const res = mockRes();
    await handler(request({ profile: 'gatewaze', prs: [], mainline: true }), res);
    expect(res.statusCode).toBe(403);
    expect(fs.writes).toEqual([]);
  });

  it('mainline does not bypass the explicit-Bearer CSRF gate', async () => {
    const handler = mount(mockSupabase());
    const res = mockRes();
    await handler({ ip: `10.1.0.${++ipSeq}`, query: {}, headers: {}, userId: 'user-1', body: { profile: 'gatewaze', prs: [], mainline: true } }, res);
    expect(res.statusCode).toBe(403);
    expect(fs.writes).toEqual([]);
  });

  it('rejects an unknown profile before touching validation or files', async () => {
    const handler = mount(mockSupabase());
    const res = mockRes();
    await handler(request({ profile: 'evil', prs: [], mainline: true }), res);
    expect(res.statusCode).toBe(422);
    expect(fs.writes).toEqual([]);
  });
});
