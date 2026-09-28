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
const DARK = { needs: true, exposure: 40, contrast: 10, warmth: 0, saturation: 0, sharpen: 20, note: 'A little dark.' };

function setup(over = {}) {
  const state = { updated: [], asked: [] };
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: over.row === undefined ? PHOTO : over.row, error: null }) }) }),
      update: (fields) => { state.updated.push(fields); return { eq: () => Promise.resolve({ error: null }) }; },
    }),
    storage: { from: () => ({
      list: (_dir, opts) => Promise.resolve({ data: over.missing ? [] : [{ name: opts.search }], error: null }),
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

  // The api never decodes a photograph: it says what is needed and the
  // organiser's browser does the work (two outages taught us this).
  it('hands the browser what to do, and never touches the picture', async () => {
    const { routes, state } = setup({ verdict: { ok: true, verdict: DARK } });
    const res = await call(routes, { ids: [MEDIA] });
    const r = res.body.results[0];
    expect(r.status).toBe('needs');
    expect(r.source).toBe(`https://cdn.example/event/${EVENT}/${MEDIA}/photo.jpg`);
    // Bounded adjustments, not the model's own numbers.
    expect(r.ops.linear.multiplier).toBeCloseTo(1.03, 2);
    expect(r.of).toBe('photo');
    expect(r.ops.sharpenSigma).toBeGreaterThan(0);
    // What was decided is written down before anything is made, so an
    // interrupted run is not paid for twice.
    expect(state.updated[0].metadata.enhance.needed).toBe(true);
    expect(state.updated[0].variants).toBeUndefined();
  });

  // A booth picture's own photograph is the selfie behind it: the poster
  // was made under imagined light, the selfie in a very dark room.
  it('looks at the selfie behind a booth picture, not the poster', async () => {
    const booth = {
      ...PHOTO,
      storage_path: `event/${EVENT}/${MEDIA}/booth.jpg`,
      metadata: { album: 'booth', selfie: `event/${EVENT}/${MEDIA}/selfie.jpg` },
    };
    const { routes, state } = setup({ row: booth, verdict: { ok: true, verdict: DARK } });
    const res = await call(routes, { ids: [MEDIA] });
    expect(state.asked).toEqual([`https://cdn.example/event/${EVENT}/${MEDIA}/selfie.jpg`]);
    expect(res.body.results[0].of).toBe('selfie');
    expect(res.body.results[0].source).toContain('selfie.jpg');
    expect(state.updated[0].metadata.enhance.of).toBe('selfie');
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
    expect(res.body.results.length).toBeLessThanOrEqual(3);
    expect(state.asked.length).toBeLessThanOrEqual(3);
  });
});

// Recording a copy the browser made, with the same care a rotation gets.
describe('recording an enhanced copy', () => {
  const GOOD = { media_id: MEDIA, storage_path: `event/${EVENT}/${MEDIA}/enhanced-abc.jpg`, bytes: 400000 };
  const record = async (over, body = GOOD, params = { eventId: EVENT }) => {
    const { routes, state } = setup(over);
    const res = mockRes();
    await routes.enhanced({ params, body }, res);
    return { res, state };
  };

  it('points the row at the copy', async () => {
    const { res, state } = await record({});
    expect(res.statusCode).toBe(200);
    expect(state.updated[0].variants.enhanced).toBe(GOOD.storage_path);
    // The photograph itself is untouched.
    expect(state.updated[0].storage_path).toBeUndefined();
  });

  // Kept apart, so a selfie can never be served as the photograph -- and
  // decided here rather than taken from the browser, which is how 135
  // enhanced selfies ended up in the photograph's slot.
  it('files a booth picture\'s copy as the selfie, whatever the browser says', async () => {
    const booth = { ...PHOTO, metadata: { album: 'booth', selfie: `event/${EVENT}/${MEDIA}/selfie.jpg` } };
    for (const claimed of [{ of: 'photo' }, {}, { of: 'nonsense' }]) {
      const { res, state } = await record({ row: booth }, { ...GOOD, ...claimed });
      expect(res.statusCode).toBe(200);
      expect(state.updated[0].variants.enhanced_selfie).toBe(GOOD.storage_path);
      expect(state.updated[0].variants.enhanced).toBeUndefined();
      expect(res.body.of).toBe('selfie');
    }
  });

  it('files a photograph\'s copy as the photograph, whatever the browser says', async () => {
    const { res, state } = await record({}, { ...GOOD, of: 'selfie' });
    expect(res.statusCode).toBe(200);
    expect(state.updated[0].variants.enhanced).toBe(GOOD.storage_path);
    expect(state.updated[0].variants.enhanced_selfie).toBeUndefined();
    expect(res.body.of).toBe('photo');
  });

  it('refuses a path that is not beside the photograph', async () => {
    for (const storage_path of [
      `event/${EVENT}/11111111-1111-4111-8111-111111111111/enhanced.jpg`,
      'event/00000000-0000-4000-8000-000000000000/x/enhanced.jpg',
      `event/${EVENT}/${MEDIA}/../../escape.jpg`,
      `event/${EVENT}/${MEDIA}/enhanced.exe`,
    ]) {
      const { res, state } = await record({}, { ...GOOD, storage_path });
      expect(res.statusCode).toBe(400);
      expect(state.updated).toEqual([]);
    }
  });

  it('refuses a copy that is not in storage', async () => {
    const { res } = await record({ missing: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('not_uploaded');
  });

  it('refuses a stranger, a video, and nonsense', async () => {
    expect((await record({ allowed: null })).res.statusCode).toBe(401);
    expect((await record({ allowed: false })).res.statusCode).toBe(403);
    expect((await record({ row: { ...PHOTO, mime_type: 'video/mp4' } })).res.statusCode).toBe(400);
    expect((await record({ row: null })).res.statusCode).toBe(404);
    for (const body of [{}, { ...GOOD, bytes: 0 }, { ...GOOD, bytes: 99e9 }, { ...GOOD, media_id: 'nope' }]) {
      expect((await record({}, body)).res.statusCode).toBe(400);
    }
  });
});
