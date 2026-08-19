// @ts-nocheck — vitest harness; the route handlers are @ts-nocheck'd already.
//
// Exercises GET /test-env/related: the cross-repo related-PR heuristic the deploy UI pre-selects
// (same head branch, open, in another of the PROFILE's deployable repos). The route must be
// profile-aware end to end — the gatewaze profile resolves PRs in the `gatewaze` org, the lfx
// profile in the `linuxfoundation` org — and must only search the selected profile's repo list,
// excluding the queried repo itself.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable GitHub client double — records every (owner, repo, …) call so the tests can assert
// which ORG each profile resolves against.
const gh = vi.hoisted(() => ({
  calls: [] as any[],
  pull: null as any,
  byRepo: {} as Record<string, any[]>,
}));
vi.mock('../../lib/github.js', () => ({
  githubClient: (_token: string) => ({
    async getPullRequest(owner: string, name: string, number: number) {
      gh.calls.push(['getPullRequest', owner, name, number]);
      return gh.pull;
    },
    async listOpenPullsByHead(owner: string, name: string, headOwner: string, branch: string) {
      gh.calls.push(['listOpenPullsByHead', owner, name, headOwner, branch]);
      return gh.byRepo[name] ?? [];
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

// Chainable supabase double: `se_projects` select→maybeSingle resolves the project (getProject).
// `enc:` ciphertext is stripped by the stubbed decrypt.
function mockSupabase(config: any = {}) {
  const from = (table: string) => {
    const b: any = {
      select() { return b; }, eq() { return b; }, is() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() {
        return Promise.resolve({ data: table === 'se_projects' ? (config.project ?? null) : null, error: null });
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
  return router.handler('GET /test-env/related');
}

const PID = '11111111-2222-3333-4444-555555555555';
const PROJECT = { id: PID, site_id: 'site-1', name: 'Demo', github_token_ciphertext: 'enc:ghp_demotoken', github_token_kind: 'pat' };

// Unique per-test IP so the in-memory rate limiter never couples tests.
let ipSeq = 0;
const request = (query: any) => ({ ip: `10.0.0.${++ipSeq}`, headers: {}, query });

describe('GET /test-env/related', () => {
  beforeEach(() => { gh.calls.length = 0; gh.pull = null; gh.byRepo = {}; });

  it('rejects an unknown profile with 422', async () => {
    const handler = mount(mockSupabase({ project: PROJECT }));
    const res = mockRes();
    await handler(request({ profile: 'evil', project_id: PID, repo: 'gatewaze', number: '7' }), res);
    expect(res.statusCode).toBe(422);
    expect(gh.calls).toEqual([]);
  });

  it('rejects a repo outside the selected profile with 422 (lfx repo under gatewaze profile)', async () => {
    const handler = mount(mockSupabase({ project: PROJECT }));
    const res = mockRes();
    await handler(request({ profile: 'gatewaze', project_id: PID, repo: 'lfx-self-serve', number: '7' }), res);
    expect(res.statusCode).toBe(422);
    expect(gh.calls).toEqual([]);
  });

  it('gatewaze profile resolves against the gatewaze org and searches only the OTHER gatewaze repos', async () => {
    gh.pull = { head: { ref: 'feat/x', repo: { owner: { login: 'gatewaze' } } } };
    gh.byRepo = { 'gatewaze-modules': [{ number: 12, title: 'x mods', html_url: 'u1' }] };
    const handler = mount(mockSupabase({ project: PROJECT }));
    const res = mockRes();
    await handler(request({ profile: 'gatewaze', project_id: PID, repo: 'gatewaze', number: '7' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ branch: 'feat/x', related: [{ repo: 'gatewaze-modules', number: 12, title: 'x mods', url: 'u1', branch: 'feat/x' }] });
    expect(gh.calls[0]).toEqual(['getPullRequest', 'gatewaze', 'gatewaze', 7]);
    const searched = gh.calls.slice(1);
    expect(searched.every(([, owner]) => owner === 'gatewaze')).toBe(true);
    expect(searched.map(([, , name]) => name)).toEqual(['gatewaze-modules', 'lf-gatewaze-modules']); // queried repo excluded
  });

  it('lfx profile resolves against the linuxfoundation org and searches only the OTHER lfx repos', async () => {
    gh.pull = { head: { ref: 'feat/lfx-y', repo: { owner: { login: 'linuxfoundation' } } } };
    gh.byRepo = { 'lfx-v2-helm': [{ number: 33, title: 'helm y', html_url: 'u2' }] };
    const handler = mount(mockSupabase({ project: PROJECT }));
    const res = mockRes();
    await handler(request({ profile: 'lfx', project_id: PID, repo: 'lfx-self-serve', number: '5' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.branch).toBe('feat/lfx-y');
    expect(res.body.related).toEqual([{ repo: 'lfx-v2-helm', number: 33, title: 'helm y', url: 'u2', branch: 'feat/lfx-y' }]);
    expect(gh.calls[0]).toEqual(['getPullRequest', 'linuxfoundation', 'lfx-self-serve', 5]);
    const searched = gh.calls.slice(1);
    expect(searched.length).toBe(6); // the 7 lfx repos minus the queried one
    expect(searched.every(([, owner]) => owner === 'linuxfoundation')).toBe(true);
    expect(searched.some(([, , name]) => name === 'lfx-self-serve')).toBe(false);
  });

  it('falls back to the PROFILE org as headOwner when the head repo owner is missing (lfx)', async () => {
    gh.pull = { head: { ref: 'feat/z' } }; // fork deleted / owner absent
    const handler = mount(mockSupabase({ project: PROJECT }));
    const res = mockRes();
    await handler(request({ profile: 'lfx', project_id: PID, repo: 'lfx-v2-helm', number: '9' }), res);
    expect(res.statusCode).toBe(200);
    const searched = gh.calls.slice(1);
    expect(searched.every(([, , , headOwner]) => headOwner === 'linuxfoundation')).toBe(true);
  });
});
