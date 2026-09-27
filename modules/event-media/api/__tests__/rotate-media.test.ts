// @ts-nocheck — vitest harness.

import { describe, it, expect, vi } from 'vitest';
import { createRotateMedia } from '../rotate-media.js';

const EVENT = '99999999-8888-4777-8666-555555555555';
const MEDIA = '11111111-2222-4333-8444-555555555555';
const logger = { info: () => {}, warn: () => {}, error: () => {} };

function mockRes() {
  const res = { statusCode: 200, body: undefined, status(s) { res.statusCode = s; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

function setup(over = {}) {
  const row = over.row === undefined ? {
    id: MEDIA, host_kind: 'event', host_id: EVENT, mime_type: 'image/jpeg',
    storage_path: `event/${EVENT}/${MEDIA}/photo.jpg`,
    variants: { plate: `event/${EVENT}/${MEDIA}/variants/plate.jpg`, thumb: 'https://cdn.example/thumb.jpg' },
    metadata: { album: 'day' },
  } : over.row;
  const state = { updated: null, removed: [] };
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
      update: (fields) => { state.updated = fields; return { eq: () => Promise.resolve({ error: over.updateError ?? null }) }; },
    }),
    storage: {
      from: () => ({
        // Everything the caller offers exists, unless the test says otherwise.
        list: (dir, opts) => Promise.resolve({ data: over.missing ? [] : [{ name: opts.search }], error: null }),
        remove: (paths) => { state.removed.push(...paths); return Promise.resolve({ error: null }); },
      }),
    },
  };
  const routes = createRotateMedia({
    canAdminEvent: async () => ('allowed' in over ? over.allowed : true),
    serviceClient: db,
    storageBucket: 'media',
    logger,
  });
  return { routes, state };
}

const body = (over = {}) => ({
  storage_path: `event/${EVENT}/${MEDIA}/rot-abc.jpg`,
  width: 1200, height: 900, bytes: 400000, quarters: 1,
  variants: { plate: `event/${EVENT}/${MEDIA}/rot-plate-abc.jpg` },
  ...over,
});
const call = async (routes, b, params = { eventId: EVENT, mediaId: MEDIA }) => {
  const res = mockRes();
  await routes.rotated({ params, body: b }, res);
  return res;
};

describe('recording a rotation', () => {
  it('points the row at the turned files and clears away the old ones', async () => {
    const { routes, state } = setup();
    const res = await call(routes, body());
    expect(res.statusCode).toBe(200);
    expect(state.updated.storage_path).toBe(`event/${EVENT}/${MEDIA}/rot-abc.jpg`);
    expect(state.updated.width).toBe(1200);
    expect(state.updated.variants.plate).toBe(`event/${EVENT}/${MEDIA}/rot-plate-abc.jpg`);
    // A variant the row had as a URL rather than an object is untouched.
    expect(state.updated.variants.thumb).toBe('https://cdn.example/thumb.jpg');
    expect(state.updated.metadata.rotated_quarters).toBe(1);
    expect(state.removed).toContain(`event/${EVENT}/${MEDIA}/photo.jpg`);
    expect(state.removed).toContain(`event/${EVENT}/${MEDIA}/variants/plate.jpg`);
  });

  // The paths come from a browser, so they are checked rather than trusted.
  it('refuses a path outside this event', async () => {
    const { routes, state } = setup();
    const res = await call(routes, body({ storage_path: `event/${'0'.repeat(8)}-0000-4000-8000-000000000000/x/rot.jpg` }));
    expect(res.statusCode).toBe(400);
    expect(state.updated).toBeNull();
  });

  // Inside the event but beside a different photo: this would repoint one
  // row at another's file and then delete this row's own original.
  it('refuses a path in another photo\'s folder', async () => {
    const { routes, state } = setup();
    const res = await call(routes, body({ storage_path: `event/${EVENT}/${'2'.repeat(8)}-2222-4333-8444-555555555555/rot.jpg` }));
    expect(res.statusCode).toBe(400);
    expect(state.updated).toBeNull();
  });

  // The row is written as a JPEG and its old file removed, so a video
  // sent here would be lost rather than turned.
  it('refuses anything that is not a photo', async () => {
    const { routes, state } = setup({ row: {
      id: MEDIA, host_kind: 'event', host_id: EVENT, mime_type: 'video/mp4',
      storage_path: `event/${EVENT}/${MEDIA}/clip.mp4`, variants: {}, metadata: {},
    } });
    const res = await call(routes, body());
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('not_a_photo');
    expect(state.updated).toBeNull();
  });

  it('ignores a layer the photo never had, and one pointing elsewhere', async () => {
    const { routes, state } = setup();
    await call(routes, body({ variants: {
      depth: `event/${EVENT}/${MEDIA}/rot-depth.png`,                       // never had one
      plate: `event/${'1'.repeat(8)}-2222-4333-8444-555555555555/p.jpg`,    // another event
    } }));
    expect(state.updated.variants.depth).toBeUndefined();
    expect(state.updated.variants.plate).toBe(`event/${EVENT}/${MEDIA}/variants/plate.jpg`);
  });

  it('refuses when the turned file is not in storage yet', async () => {
    const { routes, state } = setup({ missing: true });
    const res = await call(routes, body());
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('not_uploaded');
    expect(state.updated).toBeNull();
  });

  it('refuses another event\'s photo, a stranger, and nonsense', async () => {
    const other = await call(setup({ row: { id: MEDIA, host_kind: 'event', host_id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/jpeg', variants: {} } }).routes, body());
    expect(other.statusCode).toBe(404);
    const denied = await call(setup({ allowed: false }).routes, body());
    expect(denied.statusCode).toBe(403);
    const loggedOut = await call(setup({ allowed: null }).routes, body());
    expect(loggedOut.statusCode).toBe(401);
    for (const bad of [{ quarters: 4 }, { quarters: 0 }, { width: 0 }, { bytes: -1 }, { storage_path: 'x.exe' }]) {
      expect((await call(setup().routes, body(bad))).statusCode).toBe(400);
    }
  });
});
