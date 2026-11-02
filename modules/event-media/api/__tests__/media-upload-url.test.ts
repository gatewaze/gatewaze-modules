// @ts-nocheck — vitest harness.
import { describe, it, expect } from 'vitest';
import { createMediaUploadUrl } from '../media-upload-url.js';
import { fakeMedia } from './fake-media.js';

const EVENT = '99999999-8888-4777-8666-555555555555';
const MEDIA = '11111111-2222-4333-8444-555555555555';
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const mockRes = () => { const r = { statusCode: 200, body: undefined, status(s) { r.statusCode = s; return r; }, json(b) { r.body = b; return r; } }; return r; };

function setup(over = {}) {
  const row = over.row === undefined ? {
    id: MEDIA, host_kind: 'event', host_id: EVENT, mime_type: 'image/jpeg',
    storage_path: `event/${EVENT}/${MEDIA}/photo.jpg`, storage_provider: 'r2', storage_bucket: 'aime-media',
  } : over.row;
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }) };
  // Nothing is at the new name yet, unless a test says otherwise.
  const fm = fakeMedia({ base: 'https://media.example', unavailable: over.unavailable, missing: over.exists ? false : true });
  const routes = createMediaUploadUrl({ canAdminEvent: async () => ('allowed' in over ? over.allowed : true), serviceClient: db, media: fm.media, logger });
  return { routes, fm };
}
const call = async (routes, body, params = { eventId: EVENT, mediaId: MEDIA }) => { const res = mockRes(); await routes.uploadUrl({ params, body }, res); return res; };

describe('an upload address beside a photo', () => {
  it('signs an upload in the store the photo is in, inside its own folder', async () => {
    const { routes, fm } = setup();
    const res = await call(routes, { name: 'rot-abc.jpg', content_type: 'image/jpeg', bytes: 1234 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      storage_path: `event/${EVENT}/${MEDIA}/rot-abc.jpg`,
      upload_url: `https://media.example/upload/event/${EVENT}/${MEDIA}/rot-abc.jpg`,
      upload_headers: { 'content-type': 'image/jpeg' },
    });
    expect(fm.state.rows[0]).toMatchObject({ storage_provider: 'r2', storage_bucket: 'aime-media' });
    expect(fm.state.signed[0]).toMatchObject({ contentType: 'image/jpeg', bytes: 1234, expiresSeconds: 900 });
  });

  it('refuses names that are folders, other types, or a mismatched type', async () => {
    const { routes } = setup();
    for (const b of [
      { name: '../x.jpg', content_type: 'image/jpeg', bytes: 1 },
      { name: 'a/b.jpg', content_type: 'image/jpeg', bytes: 1 },
      { name: 'x.svg', content_type: 'image/svg+xml', bytes: 1 },
      { name: 'x.jpg', content_type: 'image/png', bytes: 1 },
      { name: 'x.jpg', content_type: 'image/jpeg', bytes: 0 },
      { name: 'rot-X.jpg', content_type: 'image/jpeg', bytes: 1 },
      // The shape an original's own name has: never signable here.
      { name: 'photo.jpg', content_type: 'image/jpeg', bytes: 1 },
    ]) {
      expect((await call(routes, b)).statusCode).toBe(400);
    }
  });

  it('refuses a name that is already taken, so nothing is overwritten', async () => {
    const { routes, fm } = setup();
    fm.media.forRow = async () => {
      const s = { provider: 'r2', bucket: 'b-1', head: async () => ({ ok: true, bytes: 1, contentType: 'image/jpeg' }), signUpload: async () => { throw new Error('must not sign'); } };
      return { browser: s, direct: s };
    };
    expect((await call(routes, { name: 'rot-abc.jpg', content_type: 'image/jpeg', bytes: 1 })).statusCode).toBe(409);
  });

  it('refuses somebody who may not manage the event, and a photo of another event', async () => {
    expect((await call(setup({ allowed: false }).routes, { name: 'rot-a.jpg', content_type: 'image/jpeg', bytes: 1 })).statusCode).toBe(403);
    expect((await call(setup({ allowed: null }).routes, { name: 'rot-a.jpg', content_type: 'image/jpeg', bytes: 1 })).statusCode).toBe(401);
    const other = setup({ row: { id: MEDIA, host_kind: 'event', host_id: '00000000-0000-4000-8000-000000000000', mime_type: 'image/jpeg', storage_path: 'event/x/y/z.jpg' } });
    expect((await call(other.routes, { name: 'rot-a.jpg', content_type: 'image/jpeg', bytes: 1 })).statusCode).toBe(404);
  });

  it('refuses a photo stored outside its event folder, and says so when its store is unavailable', async () => {
    const odd = setup({ row: { id: MEDIA, host_kind: 'event', host_id: EVENT, mime_type: 'image/jpeg', storage_path: 'legacy-events-media/abc' } });
    expect((await call(odd.routes, { name: 'rot-a.jpg', content_type: 'image/jpeg', bytes: 1 })).statusCode).toBe(409);
    expect((await call(setup({ unavailable: true }).routes, { name: 'rot-a.jpg', content_type: 'image/jpeg', bytes: 1 })).statusCode).toBe(503);
  });
});
