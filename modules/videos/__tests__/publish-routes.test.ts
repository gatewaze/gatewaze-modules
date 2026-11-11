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
let failUpdate = false;
let sb = fakeSupabase(() => ({ data: null }));
let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(() => {
  const router = express.Router();
  mountEditorRoutes(router, {
    supabase: { from: (t: string) => sb.client.from(t), storage: {}, rpc: async () => ({ data: null, error: null }) },
    userClient: (req) => (req.headers.authorization ? { rpc: async () => ({ data: isAdmin, error: null }), auth: { getUser: async () => ({ data: { user: null } }) } } : null),
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
  video = { id: VID, visibility: 'public', status: 'draft' };
  isAdmin = true;
  failUpdate = false;
  sb = fakeSupabase((c: Chain) => {
    if (c.calls.some((x) => x.op === 'update')) return failUpdate ? { error: { message: 'boom' } } : { data: null };
    return { data: video };
  });
});

const post = (path: string, auth = true) =>
  fetch(`${base}${path}`, { method: 'POST', headers: auth ? { authorization: 'Bearer t' } : {} });
const update = () => sb.chains.find((c) => c.calls.some((x) => x.op === 'update'));

describe('publish and unpublish', () => {
  it('publishes a public video, writing both status columns', async () => {
    const r = await post(`/videos/${VID}/publish`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, status: 'published' });
    expect(update()!.arg('update')).toEqual({ publish_state: 'published', status: 'published' });
    expect(update()!.has('eq', 'id', VID)).toBe(true);
  });

  it('unpublishes to archived, which auto-publish never undoes', async () => {
    const r = await post(`/videos/${VID}/unpublish`);
    expect(await r.json()).toEqual({ ok: true, status: 'archived' });
    expect(update()!.arg('update')).toEqual({ publish_state: 'unpublished', status: 'archived' });
  });

  it('refuses to publish a video that is private or unlisted on its platform', async () => {
    video = { id: VID, visibility: 'private', status: 'draft' };
    expect((await post(`/videos/${VID}/publish`)).status).toBe(409);
    expect(update()).toBeUndefined();
    // Unpublishing it is still allowed.
    expect((await post(`/videos/${VID}/unpublish`)).status).toBe(200);
  });

  it('needs a session and an admin', async () => {
    expect((await post(`/videos/${VID}/publish`, false)).status).toBe(401);
    isAdmin = false;
    expect((await post(`/videos/${VID}/publish`)).status).toBe(403);
    isAdmin = null;
    expect((await post(`/videos/${VID}/publish`)).status).toBe(403);
    expect(update()).toBeUndefined();
  });

  it('answers 400 for a malformed id, 404 for an unknown one, 500 for a failed write', async () => {
    expect((await post('/videos/nope/publish')).status).toBe(400);
    video = null;
    expect((await post(`/videos/${VID}/publish`)).status).toBe(404);
    video = { id: VID, visibility: 'public', status: 'draft' };
    failUpdate = true;
    const r = await post(`/videos/${VID}/publish`);
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('boom');
  });
});
