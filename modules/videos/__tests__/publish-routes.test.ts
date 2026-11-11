/**
 * Publish / Unpublish on the triage queue (api/editor-routes.ts), mounted on
 * a real Express router with a fake service client and caller client.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mountEditorRoutes } from '../api/editor-routes.js';
import { fakeSupabase, type Chain } from './helpers/fake-supabase.js';

const VID = 'f0000000-0000-0000-0000-000000000001';
let video: Record<string, unknown> | null = null;
let isAdmin: boolean | null = true;
let adminRpcError: unknown = null;
let userRpcNames: string[] = [];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcError: { message: string } | null = null;
let failRead = false;
let failRepair = false;
let sb = fakeSupabase(() => ({ data: null }));
let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(() => {
  const router = express.Router();
  mountEditorRoutes(router, {
    supabase: {
      from: (t: string) => sb.client.from(t),
      storage: {},
      rpc: async (fn: string, args: Record<string, unknown>) => { rpcCalls.push({ fn, args }); return { data: null, error: rpcError }; },
    },
    userClient: (req) => (req.headers.authorization
      ? {
          rpc: async (fn: string) => { userRpcNames.push(fn); return { data: fn === 'is_admin' ? isAdmin : null, error: adminRpcError }; },
          auth: { getUser: async () => ({ data: { user: { id: 'a0000000-0000-0000-0000-00000000000a' } } }) },
        }
      : null),
    logger: { info: () => {}, warn: () => {} },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/video-editor', router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/video-editor`;
});
afterAll(() => server.close());

beforeEach(() => {
  video = { id: VID, visibility: 'public', status: 'draft', publish_state: 'draft' };
  isAdmin = true;
  adminRpcError = null;
  userRpcNames = [];
  rpcCalls = [];
  rpcError = null;
  failRead = false;
  failRepair = false;
  sb = fakeSupabase((c: Chain) => {
    if (c.calls.some((x) => x.op === 'update')) return failRepair ? { error: { message: 'boom' } } : { data: null };
    return failRead ? { error: { message: 'boom' } } : { data: video };
  });
});

const post = (path: string, auth = true) =>
  fetch(`${base}${path}`, { method: 'POST', headers: auth ? { authorization: 'Bearer t' } : {} });
const repair = () => sb.chains.find((c) => c.calls.some((x) => x.op === 'update'));

describe('publish and unpublish', () => {
  it('publishes through content_publish_state_set, with the admin as actor, and repairs a stale status', async () => {
    const r = await post(`/videos/${VID}/publish`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, status: 'published' });
    expect(userRpcNames).toContain('is_admin');
    expect(rpcCalls).toEqual([{
      fn: 'content_publish_state_set',
      args: expect.objectContaining({ p_content_type: 'video', p_content_id: VID, p_to: 'published', p_actor: 'admin:a0000000-0000-0000-0000-00000000000a' }),
    }]);
    const fix = repair()!;
    expect(fix.arg('update')).toEqual({ status: 'published' });
    expect(fix.has('eq', 'publish_state', 'published')).toBe(true);
    expect(fix.has('neq', 'status', 'published')).toBe(true);
  });

  it('unpublishes a published video through the state machine', async () => {
    video = { id: VID, visibility: 'public', status: 'published', publish_state: 'published' };
    const r = await post(`/videos/${VID}/unpublish`);
    expect(await r.json()).toEqual({ ok: true, status: 'archived' });
    expect(rpcCalls[0].args.p_to).toBe('unpublished');
    expect(repair()).toBeUndefined();
  });

  it('refuses to unpublish a video that is not published', async () => {
    expect((await post(`/videos/${VID}/unpublish`)).status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it('refuses to publish a video that is private or unlisted on its platform', async () => {
    video = { id: VID, visibility: 'private', status: 'draft', publish_state: 'draft' };
    expect((await post(`/videos/${VID}/publish`)).status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it('answers a transition the state machine refuses with 409', async () => {
    video = { id: VID, visibility: 'public', status: 'rejected', publish_state: 'rejected' };
    rpcError = { message: 'INVALID_STATE_TRANSITION: video.x rejected -> published' };
    const r = await post(`/videos/${VID}/publish`);
    expect(r.status).toBe(409);
    expect(repair()).toBeUndefined();
  });

  it('needs a session and an admin, and an is_admin error is a refusal', async () => {
    expect((await post(`/videos/${VID}/publish`, false)).status).toBe(401);
    isAdmin = false;
    expect((await post(`/videos/${VID}/publish`)).status).toBe(403);
    isAdmin = true;
    adminRpcError = { message: 'boom' };
    expect((await post(`/videos/${VID}/publish`)).status).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it('answers 400, 404 and 500 without detail', async () => {
    expect((await post('/videos/nope/publish')).status).toBe(400);
    video = null;
    expect((await post(`/videos/${VID}/publish`)).status).toBe(404);
    video = { id: VID, visibility: 'public', status: 'draft', publish_state: 'draft' };
    failRead = true;
    expect((await post(`/videos/${VID}/publish`)).status).toBe(500);
    failRead = false;
    rpcError = { message: 'boom' };
    expect((await post(`/videos/${VID}/publish`)).status).toBe(500);
    rpcError = null;
    failRepair = true;
    const r = await post(`/videos/${VID}/publish`);
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('boom');
  });
});
