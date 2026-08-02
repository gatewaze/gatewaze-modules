// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises POST /issues attachment handling (issue #16): the server appends only allowlisted
// (https, SUPABASE_URL-origin) attachment URLs to the issue body, and REPORTS how many were dropped
// so the client can warn instead of showing a silent success. On localhost the client's public
// storage URL is http://…localhost and is dropped by the SSRF allowlist.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Capture createIssue args without a live GitHub call (hoisted so the vi.mock factory can close over it).
const gh = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../lib/github.js', () => ({
  githubClient: () => ({
    createIssue: async (owner: string, name: string, opts: any) => {
      gh.calls.push({ owner, name, opts });
      return { number: 42, html_url: `https://github.com/${owner}/${name}/issues/42` };
    },
  }),
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

// Chainable supabase double — enough for getProject (se_projects select) on the non-assign path.
function mockSupabase(config: any = {}) {
  const resolve = (state: any) => {
    if (state.table === 'se_projects' && state.op === 'select') return { data: config.project ?? null, error: null };
    return { data: null, error: null };
  };
  const from = (table: string) => {
    const state: any = { table, op: 'select' };
    const b: any = {
      select() { return b; },
      insert() { state.op = 'insert'; return b; },
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
  mountAdminRoutes(router as never, {
    supabase, getRedis: () => null, logger: { warn() {}, info() {} }, enqueueJob: async () => {},
  });
  return router;
}

// A fully-configured project with an issues repo + token (enc: prefix stripped by the stubbed decrypt).
const PROJECT = {
  id: 'p1', site_id: 'site-1', name: 'Demo', intake_enabled: true,
  github_token_ciphertext: 'enc:ghp_demotoken', github_token_kind: 'pat',
  issues_repo_owner: 'acme', issues_repo_name: 'issues', trigger_label: 'agent:build',
};
const PID = '11111111-2222-3333-4444-555555555555';
const SUPA = 'https://storage.example.supabase.co';

describe('POST /issues attachment reporting', () => {
  beforeEach(() => { gh.calls.length = 0; process.env.SUPABASE_URL = SUPA; });
  afterEach(() => { delete process.env.SUPABASE_URL; });

  it('appends an allowlisted https attachment and reports it attached', async () => {
    const router = mount(mockSupabase({ project: PROJECT }));
    const res = mockRes();
    await router.handler('POST /issues')({
      body: { project_id: PID, title: 'Broken button', body: 'see shot', assign_to_agent: false,
        attachments: [{ url: `${SUPA}/storage/v1/object/public/media/a.png` }] },
      userId: 'u1',
    }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ number: 42, attachmentsAttached: 1, attachmentsDropped: 0 });
    const body = gh.calls[0].opts.body as string;
    expect(body).toContain('### Attachments');
    expect(body).toContain(`![screenshot-1](${SUPA}/storage/v1/object/public/media/a.png)`);
  });

  it('drops an http/localhost storage URL and reports it dropped, leaving the body clean', async () => {
    const router = mount(mockSupabase({ project: PROJECT }));
    const res = mockRes();
    await router.handler('POST /issues')({
      body: { project_id: PID, title: 'Broken button', body: 'see shot', assign_to_agent: false,
        attachments: [{ url: 'http://supabase.gatewaze.localhost/storage/v1/object/public/media/a.png' }] },
      userId: 'u1',
    }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ attachmentsAttached: 0, attachmentsDropped: 1 });
    const body = gh.calls[0].opts.body as string;
    expect(body).not.toContain('### Attachments');
  });

  it('reports zero dropped when no attachments are provided', async () => {
    const router = mount(mockSupabase({ project: PROJECT }));
    const res = mockRes();
    await router.handler('POST /issues')({
      body: { project_id: PID, title: 'No image', body: 'plain', assign_to_agent: false },
      userId: 'u1',
    }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ attachmentsAttached: 0, attachmentsDropped: 0 });
  });

  it('mixes allowlisted + dropped and counts each', async () => {
    const router = mount(mockSupabase({ project: PROJECT }));
    const res = mockRes();
    await router.handler('POST /issues')({
      body: { project_id: PID, title: 'Two shots', body: '', assign_to_agent: false,
        attachments: [
          { url: `${SUPA}/storage/v1/object/public/media/ok.png` },
          { url: 'https://evil.example.com/x.png' },
        ] },
      userId: 'u1',
    }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ attachmentsAttached: 1, attachmentsDropped: 1 });
    const body = gh.calls[0].opts.body as string;
    expect(body).toContain(`![screenshot-1](${SUPA}/storage/v1/object/public/media/ok.png)`);
    expect(body).not.toContain('evil.example.com');
  });
});
