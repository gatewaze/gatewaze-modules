// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises the hostname-keyed multi-env channel (spec §4.3, phase 2):
//   GET    /test-env/envs             — registry + status list (+ events ingest side-effect)
//   POST   /test-env/envs             — canonical-label create request
//   DELETE /test-env/envs/:label      — teardown request
//   POST   /test-env/envs/:label/refresh — redeploy from the registry's own spec
//
// The invariant under test everywhere: the request FILENAME is the label the
// SERVER computed from the validated spec (the label IS the env identity) —
// user input never names a file, Tier-B/helm specs are refused with the host
// agent's explanations, and the super-admin + explicit-Bearer gates hold.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Virtual /staging-control filesystem. envs/ holds <label>.json (registry)
// and <label>.status.json; envs/requests/ holds the control files the routes
// write. readdirSync/statSync serve the same virtual tree.
const vfs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as Array<[string, any]>,
  reset() { this.files.clear(); this.writes.length = 0; },
}));
vi.mock('node:fs', () => ({
  existsSync: (p: string) => p === '/staging-control' || p === '/staging-control/envs'
    || p === '/staging-control/envs/requests' || vfs.files.has(p),
  readFileSync: (p: string, enc?: string) => {
    if (!vfs.files.has(p)) throw new Error('ENOENT');
    const content = vfs.files.get(p) as string;
    return enc ? content : Buffer.from(content); // no-encoding callers (env-events) expect a Buffer
  },
  writeFileSync: (p: string, body: string) => {
    vfs.files.set(p, body);
    vfs.writes.push([p, JSON.parse(body)]);
  },
  readdirSync: (p: string) => {
    const prefix = `${p}/`;
    return [...vfs.files.keys()]
      .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
      .map((f) => f.slice(prefix.length));
  },
  statSync: (p: string) => {
    if (!vfs.files.has(p)) throw new Error('ENOENT');
    return { size: Buffer.byteLength(vfs.files.get(p)) };
  },
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

// Chainable supabase double. admin_profiles feeds the super-admin gate;
// se_env_events/_cursor feed the ingest side-effect (recorded, not asserted
// deeply here — lib/__tests__/env-events.test.ts covers ingestion itself).
function mockSupabase(role = 'super_admin') {
  const inserts: Array<[string, any]> = [];
  const from = (table: string) => {
    const b: any = {
      select() { return b; }, eq() { return b; }, in() { return b; }, is() { return b; },
      order() { return b; }, limit() { return Promise.resolve({ data: [], error: null }); },
      maybeSingle() {
        return Promise.resolve({ data: table === 'admin_profiles' ? { role } : null, error: null });
      },
      insert(rows: any) { inserts.push([table, rows]); return Promise.resolve({ data: null, error: null }); },
      upsert(row: any) { inserts.push([table, row]); return Promise.resolve({ data: null, error: null }); },
    };
    return b;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }), _inserts: inserts };
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
  ip: `10.2.0.${++ipSeq}`, query: {}, params: {}, body: {},
  headers: { authorization: 'Bearer test-token' },
  userId: 'user-1',
  ...over,
});

const REG = (label: string) => `/staging-control/envs/${label}.json`;
const STATUS = (label: string) => `/staging-control/envs/${label}.status.json`;
const REQ = (label: string) => `/staging-control/envs/requests/${label}.request.json`;

const seedEnv = (label: string, registry: any = {}, status: any = { state: 'ready', detail: 'Deployed', urls: [], updated_at: '2026-08-23T10:00:00Z' }) => {
  vfs.files.set(REG(label), JSON.stringify({
    label, profile: 'lfx', spec: [{ repo: 'lfx-v2-newsletter-service', pr: 80 }],
    hostnames: { app: `${label}.pr-view.com`, api: `${label}-api.pr-view.com` },
    app_port: 4201, k8s_suffix: 'fa2c7224', live: true, images: {},
    created_at: '2026-08-23T09:00:00Z', last_activity_at: '2026-08-23T09:30:00Z',
    ttl_hours: 3, expires_at: '2026-08-23T12:30:00Z', status: 'ready', ...registry,
  }));
  if (status) vfs.files.set(STATUS(label), JSON.stringify(status));
};

beforeEach(() => vfs.reset());

describe('GET /test-env/envs', () => {
  it('lists registry envs with their statuses and pending flags', async () => {
    seedEnv('lfx--newsletter-80');
    const h = mount(mockSupabase()).handler('GET /test-env/envs');
    const res = mockRes();
    await h(request(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.envs).toHaveLength(1);
    const e = res.body.envs[0];
    expect(e.label).toBe('lfx--newsletter-80');
    expect(e.registry.app_port).toBe(4201);
    expect(e.status.state).toBe('ready');
    expect(e.pending).toBe(false);
  });

  it('excludes .status/.k8s siblings and non-label files from the label list', async () => {
    seedEnv('lfx--newsletter-80');
    vfs.files.set('/staging-control/envs/lfx--newsletter-80.k8s.json', '{}');
    vfs.files.set('/staging-control/envs/evil.json', '{}');               // not lfx-- prefixed
    vfs.files.set('/staging-control/envs/lfx--newsletter-80.app.log', 'x');
    const h = mount(mockSupabase()).handler('GET /test-env/envs');
    const res = mockRes();
    await h(request(), res);
    expect(res.body.envs.map((e: any) => e.label)).toEqual(['lfx--newsletter-80']);
  });

  it('surfaces a status-only label (admission refusal — error status, no registry)', async () => {
    vfs.files.set(STATUS('lfx--newsletter-81'), JSON.stringify({
      state: 'error',
      detail: 'admission refused: environment cap reached (1 extra envs). Current envs: lfx--newsletter-80 (expires 2026-08-23T20:43:42Z).',
      urls: null, updated_at: '2026-08-23T17:45:44Z',
    }));
    const h = mount(mockSupabase()).handler('GET /test-env/envs');
    const res = mockRes();
    await h(request(), res);
    expect(res.body.envs).toHaveLength(1);
    expect(res.body.envs[0]).toMatchObject({ label: 'lfx--newsletter-81', registry: null });
    expect(res.body.envs[0].status.state).toBe('error');
    expect(res.body.envs[0].status.detail).toContain('admission refused');
  });

  it('surfaces a queued create (request file, no registry yet) as a pending env', async () => {
    vfs.files.set(REQ('lfx--newsletter-81'), JSON.stringify({ action: 'create' }));
    const h = mount(mockSupabase()).handler('GET /test-env/envs');
    const res = mockRes();
    await h(request(), res);
    expect(res.body.envs).toHaveLength(1);
    expect(res.body.envs[0]).toMatchObject({ label: 'lfx--newsletter-81', registry: null, pending: true });
  });

  it('rejects unknown profiles with 422', async () => {
    const h = mount(mockSupabase()).handler('GET /test-env/envs');
    const res = mockRes();
    await h(request({ query: { profile: 'gatewaze' } }), res);
    expect(res.statusCode).toBe(422);
  });

  it('ingests new events.jsonl lines into se_env_events as a poll side-effect', async () => {
    vfs.files.set('/staging-control/events.jsonl',
      '{"ts":"2026-08-23T10:00:00Z","kind":"ready","env":"lfx--newsletter-80","detail":"deployed"}\n');
    const sb = mockSupabase();
    const h = mount(sb).handler('GET /test-env/envs');
    await h(request(), mockRes());
    const eventInserts = sb._inserts.filter(([t]) => t === 'se_env_events');
    expect(eventInserts).toHaveLength(1);
    expect(eventInserts[0][1][0]).toMatchObject({ kind: 'ready', env_label: 'lfx--newsletter-80' });
  });
});

describe('POST /test-env/envs', () => {
  const h = () => mount(mockSupabase()).handler('POST /test-env/envs');

  it('writes a create request named by the CANONICAL label computed server-side', async () => {
    const res = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-v2-newsletter-service', pr: 63 }, { repo: 'lfx-v2-newsletter-service', pr: 71 }] } }), res);
    expect(res.statusCode).toBe(202);
    expect(vfs.writes).toHaveLength(1);
    const [path, payload] = vfs.writes[0];
    expect(path).toBe(REQ('lfx--newsletter-63-71')); // adjacent groups merged — canonical form
    expect(payload).toMatchObject({
      action: 'create',
      spec: [{ repo: 'lfx-v2-newsletter-service', pr: 63 }, { repo: 'lfx-v2-newsletter-service', pr: 71 }],
      live: true, // multi-env default is live
      requested_by: 'user-1',
    });
  });

  it('accepts branch entries and slugs them into the label while the request keeps the exact ref', async () => {
    const res = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-v2-newsletter-service', branch: 'feat/send-retry' }] } }), res);
    expect(res.statusCode).toBe(202);
    const [path, payload] = vfs.writes[0];
    expect(path).toBe(REQ('lfx--newsletter-b-feat-send-retry'));
    expect(payload.spec).toEqual([{ repo: 'lfx-v2-newsletter-service', branch: 'feat/send-retry' }]);
  });

  it('forwards live: false and ttl_hours when given (strict types)', async () => {
    const res = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-self-serve', pr: 3 }], live: false, ttl_hours: 12 } }), res);
    expect(res.statusCode).toBe(202);
    expect(vfs.writes[0][1]).toMatchObject({ live: false, ttl_hours: 12 });
  });

  it('rejects a non-boolean live and a non-integer/out-of-range ttl_hours with 422', async () => {
    for (const body of [
      { spec: [{ repo: 'lfx-self-serve', pr: 3 }], live: 'true' },
      { spec: [{ repo: 'lfx-self-serve', pr: 3 }], ttl_hours: 0 },
      { spec: [{ repo: 'lfx-self-serve', pr: 3 }], ttl_hours: 169 },
      { spec: [{ repo: 'lfx-self-serve', pr: 3 }], ttl_hours: 1.5 },
    ]) {
      const res = mockRes();
      await h()(request({ body }), res);
      expect(res.statusCode).toBe(422);
    }
    expect(vfs.writes).toEqual([]);
  });

  it('rejects Tier-B services and helm with the host agent explanations (no file written)', async () => {
    const res = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-v2-email-service', pr: 4 }] } }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body.error.message).toContain('Tier-B NATS queue-group subscriber');
    const res2 = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-v2-helm', pr: 4 }] } }), res2);
    expect(res2.statusCode).toBe(422);
    expect(res2.body.error.message).toContain('SHARED cluster');
    expect(vfs.writes).toEqual([]);
  });

  it('rejects unknown repos and malformed branches via the grammar with 422', async () => {
    for (const spec of [
      [{ repo: 'evil/../repo', pr: 1 }],
      [{ repo: 'lfx-v2-newsletter-service', pr: 0 }],
      [{ repo: 'lfx-v2-newsletter-service', branch: '../evil' }],
      [],
    ]) {
      const res = mockRes();
      await h()(request({ body: { spec } }), res);
      expect(res.statusCode).toBe(422);
    }
    expect(vfs.writes).toEqual([]);
  });

  it('409s when the env already exists (non-reaped) — refresh/teardown is the path', async () => {
    seedEnv('lfx--newsletter-80');
    const res = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-v2-newsletter-service', pr: 80 }] } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('exists');
    expect(vfs.writes).toEqual([]);
  });

  it('allows re-creating a REAPED env (its registry entry holds no resources)', async () => {
    seedEnv('lfx--newsletter-80', { status: 'reaped', app_port: null }, { state: 'reaped', detail: 'TTL expired', urls: null, updated_at: '2026-08-23T10:00:00Z' });
    const res = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-v2-newsletter-service', pr: 80 }] } }), res);
    expect(res.statusCode).toBe(202);
    expect(vfs.writes).toHaveLength(1);
  });

  it('409s at the cap counting only non-reaped envs', async () => {
    seedEnv('lfx--newsletter-1');
    seedEnv('lfx--newsletter-2');
    seedEnv('lfx--newsletter-3');
    seedEnv('lfx--newsletter-4');
    const res = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-v2-newsletter-service', pr: 5 }] } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('cap_reached');
    // Reap one — the same create is admitted.
    vfs.files.set(REG('lfx--newsletter-4'), JSON.stringify({ ...JSON.parse(vfs.files.get(REG('lfx--newsletter-4'))), status: 'reaped' }));
    const res2 = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-v2-newsletter-service', pr: 5 }] } }), res2);
    expect(res2.statusCode).toBe(202);
  });

  it('409s while a request for the same label is pending', async () => {
    vfs.files.set(REQ('lfx--newsletter-80'), JSON.stringify({ action: 'create' }));
    vfs.writes.length = 0;
    const res = mockRes();
    await h()(request({ body: { spec: [{ repo: 'lfx-v2-newsletter-service', pr: 80 }] } }), res);
    expect(res.statusCode).toBe(409);
    expect(vfs.writes).toEqual([]);
  });

  it('requires super-admin and an explicit Bearer header', async () => {
    const resRole = mockRes();
    await mount(mockSupabase('admin')).handler('POST /test-env/envs')(
      request({ body: { spec: [{ repo: 'lfx-self-serve', pr: 3 }] } }), resRole);
    expect(resRole.statusCode).toBe(403);
    const resBearer = mockRes();
    await mount(mockSupabase()).handler('POST /test-env/envs')(
      request({ headers: {}, body: { spec: [{ repo: 'lfx-self-serve', pr: 3 }] } }), resBearer);
    expect(resBearer.statusCode).toBe(403);
    expect(vfs.writes).toEqual([]);
  });
});

describe('DELETE /test-env/envs/:label', () => {
  it('writes a teardown request for a grammar-valid label', async () => {
    seedEnv('lfx--newsletter-80');
    const h = mount(mockSupabase()).handler('DELETE /test-env/envs/:label');
    const res = mockRes();
    await h(request({ params: { label: 'lfx--newsletter-80' } }), res);
    expect(res.statusCode).toBe(202);
    const [path, payload] = vfs.writes[0];
    expect(path).toBe(REQ('lfx--newsletter-80'));
    expect(payload).toMatchObject({ action: 'teardown', requested_by: 'user-1' });
  });

  it('409s (root_holder) teardown of the env holding the root domain — no request file written', async () => {
    seedEnv('lfx--newsletter-80');
    seedEnv('lfx--newsletter-81');
    vfs.files.set('/staging-control/envs/root-assignment.json', JSON.stringify({ env: 'lfx--newsletter-80' }));
    vfs.writes.length = 0;
    const h = mount(mockSupabase()).handler('DELETE /test-env/envs/:label');
    const res = mockRes();
    await h(request({ params: { label: 'lfx--newsletter-80' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('root_holder');
    expect(res.body.error.message).toMatch(/lfx\.pr-view\.com.*demote/i);
    expect(vfs.writes).toEqual([]);
    // A non-holding env still tears down normally while the assignment stands.
    const res2 = mockRes();
    await h(request({ params: { label: 'lfx--newsletter-81' } }), res2);
    expect(res2.statusCode).toBe(202);
    expect(vfs.writes[0][0]).toBe(REQ('lfx--newsletter-81'));
    expect(vfs.writes[0][1]).toMatchObject({ action: 'teardown' });
  });

  it('422s any label that fails the shape or grammar gate BEFORE building a path', async () => {
    const h = mount(mockSupabase()).handler('DELETE /test-env/envs/:label');
    for (const label of ['../etc/passwd', 'lfx--h-abcdef0123', 'gatewaze--gw-3', 'LFX--NEWSLETTER-80', 'lfx--bogus-7', 'a'.repeat(70)]) {
      const res = mockRes();
      await h(request({ params: { label } }), res);
      expect(res.statusCode).toBe(422);
    }
    expect(vfs.writes).toEqual([]);
  });

  it('requires super-admin', async () => {
    const h = mount(mockSupabase('editor')).handler('DELETE /test-env/envs/:label');
    const res = mockRes();
    await h(request({ params: { label: 'lfx--newsletter-80' } }), res);
    expect(res.statusCode).toBe(403);
    expect(vfs.writes).toEqual([]);
  });
});

describe('POST /test-env/envs/:label/refresh', () => {
  it('re-requests a deploy from the registry spec (exact branch refs preserved)', async () => {
    seedEnv('lfx--newsletter-b-feat-send-retry', {
      spec: [{ repo: 'lfx-v2-newsletter-service', branch: 'feat/send-retry' }], live: true, ttl_hours: 6,
    });
    const h = mount(mockSupabase()).handler('POST /test-env/envs/:label/refresh');
    const res = mockRes();
    await h(request({ params: { label: 'lfx--newsletter-b-feat-send-retry' } }), res);
    expect(res.statusCode).toBe(202);
    const [path, payload] = vfs.writes[0];
    expect(path).toBe(REQ('lfx--newsletter-b-feat-send-retry'));
    expect(payload).toMatchObject({
      action: 'create',
      spec: [{ repo: 'lfx-v2-newsletter-service', branch: 'feat/send-retry' }],
      live: true, ttl_hours: 6,
    });
  });

  it('404s an unknown label and 409s a registry whose spec no longer encodes to it', async () => {
    const h = mount(mockSupabase()).handler('POST /test-env/envs/:label/refresh');
    const res404 = mockRes();
    await h(request({ params: { label: 'lfx--newsletter-99' } }), res404);
    expect(res404.statusCode).toBe(404);
    seedEnv('lfx--newsletter-80', { spec: [{ repo: 'lfx-v2-newsletter-service', pr: 81 }] });
    const res409 = mockRes();
    await h(request({ params: { label: 'lfx--newsletter-80' } }), res409);
    expect(res409.statusCode).toBe(409);
    expect(vfs.writes).toEqual([]);
  });
});

describe('POST /test-env/envs/root-assignment', () => {
  const RA_REQ = '/staging-control/envs/requests/root-assignment.request.json';

  it('writes an assign-root request for a ready env', async () => {
    seedEnv('lfx--newsletter-80');
    const h = mount(mockSupabase()).handler('POST /test-env/envs/root-assignment');
    const res = mockRes();
    await h(request({ body: { env: 'lfx--newsletter-80' } }), res);
    expect(res.statusCode).toBe(202);
    const [path, payload] = vfs.writes[0];
    expect(path).toBe(RA_REQ);
    expect(payload).toMatchObject({ action: 'assign-root', env: 'lfx--newsletter-80', requested_by: 'user-1' });
  });

  it('accepts the literal "primary" (restore) without needing a registry entry', async () => {
    const h = mount(mockSupabase()).handler('POST /test-env/envs/root-assignment');
    const res = mockRes();
    await h(request({ body: { env: 'primary' } }), res);
    expect(res.statusCode).toBe(202);
    expect(vfs.writes[0][1]).toMatchObject({ action: 'assign-root', env: 'primary' });
  });

  it('rejects invalid env values before any file path is built', async () => {
    const h = mount(mockSupabase()).handler('POST /test-env/envs/root-assignment');
    for (const env of ['../etc', 'root-assignment', 'lfx--h-abcdef0123', 'LFX--NEWSLETTER-80', '', undefined]) {
      const res = mockRes();
      await h(request({ body: { env } }), res);
      expect(res.statusCode).toBe(422);
    }
    expect(vfs.writes).toEqual([]);
  });

  it('404s an unknown/reaped env and 409s a non-ready one', async () => {
    const h = mount(mockSupabase()).handler('POST /test-env/envs/root-assignment');
    const res404 = mockRes();
    await h(request({ body: { env: 'lfx--newsletter-99' } }), res404);
    expect(res404.statusCode).toBe(404);
    seedEnv('lfx--newsletter-80', { status: 'reaped' }, { state: 'reaped', detail: '', urls: null, updated_at: 'x' });
    const resReaped = mockRes();
    await h(request({ body: { env: 'lfx--newsletter-80' } }), resReaped);
    expect(resReaped.statusCode).toBe(404);
    seedEnv('lfx--newsletter-81', {}, { state: 'building-app', detail: '', urls: null, updated_at: 'x' });
    const res409 = mockRes();
    await h(request({ body: { env: 'lfx--newsletter-81' } }), res409);
    expect(res409.statusCode).toBe(409);
    expect(vfs.writes).toEqual([]);
  });

  it('409s while a root assignment is already pending and requires super-admin', async () => {
    seedEnv('lfx--newsletter-80');
    vfs.files.set(RA_REQ, JSON.stringify({ action: 'assign-root' }));
    vfs.writes.length = 0;
    const busy = mockRes();
    await mount(mockSupabase()).handler('POST /test-env/envs/root-assignment')(
      request({ body: { env: 'lfx--newsletter-80' } }), busy);
    expect(busy.statusCode).toBe(409);
    vfs.files.delete(RA_REQ);
    const forb = mockRes();
    await mount(mockSupabase('admin')).handler('POST /test-env/envs/root-assignment')(
      request({ body: { env: 'lfx--newsletter-80' } }), forb);
    expect(forb.statusCode).toBe(403);
    expect(vfs.writes).toEqual([]);
  });

  it('GET /test-env/envs reports the assignment and never lists root-assignment as an env', async () => {
    seedEnv('lfx--newsletter-80');
    vfs.files.set('/staging-control/envs/root-assignment.json', JSON.stringify({ env: 'lfx--newsletter-80' }));
    vfs.files.set('/staging-control/envs/root-assignment.status.json', JSON.stringify({ state: 'done', detail: 'lfx.pr-view.com serves lfx--newsletter-80', updated_at: 'x' }));
    const h = mount(mockSupabase()).handler('GET /test-env/envs');
    const res = mockRes();
    await h(request(), res);
    expect(res.body.root).toMatchObject({ env: 'lfx--newsletter-80', pending: false });
    expect(res.body.root.status.state).toBe('done');
    expect(res.body.envs.map((e: any) => e.label)).toEqual(['lfx--newsletter-80']);
  });

  it('GET /test-env/envs defaults the assignment to primary when no pointer exists', async () => {
    const h = mount(mockSupabase()).handler('GET /test-env/envs');
    const res = mockRes();
    await h(request(), res);
    expect(res.body.root).toMatchObject({ env: 'primary' });
  });
});

describe('GET /test-env/env-events', () => {
  it('422s a bad env filter and a bad kind filter', async () => {
    const h = mount(mockSupabase()).handler('GET /test-env/env-events');
    const res1 = mockRes();
    await h(request({ query: { env: '../x' } }), res1);
    expect(res1.statusCode).toBe(422);
    const res2 = mockRes();
    await h(request({ query: { kind: 'DROP TABLE' } }), res2);
    expect(res2.statusCode).toBe(422);
  });
});
