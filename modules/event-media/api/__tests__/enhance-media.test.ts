// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { createEnhanceMedia } from '../enhance-media.js';

const EVENT = '99999999-8888-4777-8666-555555555555';
const MEDIA = '11111111-2222-4333-8444-555555555555';
const logger = { info: () => {}, warn: () => {}, error: () => {} };

function mockRes() {
  const res = { statusCode: 200, body: undefined, status(s) { res.statusCode = s; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

const PHOTO = {
  id: MEDIA, host_kind: 'event', host_id: EVENT, mime_type: 'image/jpeg',
  storage_path: `event/${EVENT}/${MEDIA}/photo.jpg`, variants: {}, metadata: { album: 'day' },
};

const FINE = { needs: false, exposure: 0, contrast: 0, warmth: 0, saturation: 0, sharpen: 0, note: 'Nicely exposed.' };

function setup(over = {}) {
  const state = { updated: [], asked: [] };
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: over.row === undefined ? PHOTO : over.row, error: null }) }) }),
      update: (fields) => { state.updated.push(fields); return { eq: () => Promise.resolve({ error: null }) }; },
    }),
    storage: { from: () => ({
      download: () => Promise.resolve({ data: null, error: { message: 'no' } }),
      upload: () => Promise.resolve({ error: null }),
      remove: () => Promise.resolve({ error: null }),
    }) },
  };
  const routes = createEnhanceMedia({
    canAdminEvent: async () => ('allowed' in over ? over.allowed : true),
    serviceClient: db,
    storageBucket: 'media',
    publicUrl: (p) => `https://cdn.example/${p}`,
    runVerdict: async (url) => {
      state.asked.push(url);
      return over.verdict === undefined ? { ok: true, verdict: FINE } : over.verdict;
    },
    logger,
  });
  return { routes, state };
}

const call = async (routes, body, params = { eventId: EVENT }) => {
  const res = mockRes();
  await routes.enhance({ params, body }, res);
  return res;
};

describe('enhancing an album', () => {
  it('asks the model about the photograph, and leaves a good one alone', async () => {
    const { routes, state } = setup();
    const res = await call(routes, { ids: [MEDIA] });
    expect(res.statusCode).toBe(200);
    expect(state.asked).toEqual([`https://cdn.example/event/${EVENT}/${MEDIA}/photo.jpg`]);
    expect(res.body.results[0]).toEqual({ id: MEDIA, status: 'unchanged', note: 'Nicely exposed.' });
    // Recorded, so a second pass does not pay to ask again.
    expect(state.updated[0].metadata.enhance.needed).toBe(false);
    // And nothing was written to the photograph itself.
    expect(state.updated[0].variants).toBeUndefined();
    expect(state.updated[0].storage_path).toBeUndefined();
  });

  it('says so when the model cannot be asked', async () => {
    const { routes } = setup({ verdict: { ok: false, error: 'not_configured' } });
    const res = await call(routes, { ids: [MEDIA] });
    expect(res.body.results[0]).toEqual({ id: MEDIA, status: 'failed', reason: 'not_configured' });
  });

  it('passes over anything that is not this event\'s photograph', async () => {
    const cases = [
      [{ ...PHOTO, host_id: '00000000-0000-4000-8000-000000000001' }, 'not_found'],
      [null, 'not_found'],
      [{ ...PHOTO, mime_type: 'video/mp4' }, 'not_a_photo'],
      [{ ...PHOTO, storage_path: 'somewhere/else/photo.jpg' }, 'unsupported_layout'],
    ];
    for (const [row, reason] of cases) {
      const { routes, state } = setup({ row });
      const res = await call(routes, { ids: [MEDIA] });
      expect(res.body.results[0]).toEqual({ id: MEDIA, status: 'skipped', reason });
      // Nothing that is passed over costs a model call.
      expect(state.asked).toEqual([]);
    }
  });

  // Asking again costs a model call, so a photograph already looked at
  // is not looked at again unless somebody asks for that.
  it('does not pay to ask about the same photograph twice', async () => {
    const done = { ...PHOTO, metadata: { album: 'day', enhance: { at: '2026-09-27T10:00:00Z', needed: false, note: 'Fine as it is.' } } };
    const { routes, state } = setup({ row: done });
    const res = await call(routes, { ids: [MEDIA] });
    expect(state.asked).toEqual([]);
    expect(res.body.results[0]).toEqual({ id: MEDIA, status: 'unchanged', note: 'Fine as it is.', reason: 'already_done' });

    // Unless an organiser deliberately asks for it again.
    const again = setup({ row: done });
    await call(again.routes, { ids: [MEDIA], force: true });
    expect(again.state.asked).toHaveLength(1);
  });

  it('counts the same id sent twice as one photograph', async () => {
    const { routes, state } = setup();
    const res = await call(routes, { ids: [MEDIA, MEDIA, MEDIA] });
    expect(state.asked).toHaveLength(1);
    expect(res.body.results).toHaveLength(1);
  });

  it('refuses a stranger, and nonsense', async () => {
    expect((await call(setup({ allowed: null }).routes, { ids: [MEDIA] })).statusCode).toBe(401);
    expect((await call(setup({ allowed: false }).routes, { ids: [MEDIA] })).statusCode).toBe(403);
    expect((await call(setup().routes, { ids: [MEDIA] }, { eventId: 'nope' })).statusCode).toBe(400);
    for (const body of [{}, { ids: [] }, { ids: ['not-a-uuid'] }, { ids: 'all' }, null]) {
      expect((await call(setup().routes, body)).statusCode).toBe(400);
    }
  });

  it('takes only a batch at a time, however many it is given', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `1111111${i % 10}-2222-4333-8444-555555555555`);
    const { routes, state } = setup();
    const res = await call(routes, { ids: many });
    expect(res.body.results.length).toBeLessThanOrEqual(6);
    expect(state.asked.length).toBeLessThanOrEqual(6);
  });
});
