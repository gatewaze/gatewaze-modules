// @ts-nocheck — vitest harness.

import { describe, it, expect, vi } from 'vitest';
import { createBoothExamples, pickReferences } from '../booth-examples.js';
import { BOOTH_ERAS } from '../../lib/booth-eras.js';

const EVENT = '99999999-8888-4777-8666-555555555555';
const logger = { info: () => {}, warn: () => {}, error: () => {} };

function mockRes() {
  const res = { statusCode: 200, body: undefined, status(s) { res.statusCode = s; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

function makeDb({ people, theme = { version: 2, eras: { '1980s': { interior: {}, samples: { 'top-gun': 'old.jpg' } } } } }) {
  const state = { uploads: {} };
  const db = {
    from: () => {
      const b = { select: () => b, eq: () => b, order: () => b, then: (r) => r({ data: people, error: null }) };
      return b;
    },
    storage: {
      from: () => ({
        upload: (path, body) => { state.uploads[path] = body.toString(); return Promise.resolve({ error: null }); },
        download: () => Promise.resolve({ data: { text: () => Promise.resolve(JSON.stringify(theme)) }, error: null }),
      }),
    },
  };
  return { db, state };
}

const setup = (people, over = {}) => {
  const { db, state } = makeDb({ people });
  const calls = [];
  const routes = createBoothExamples({
    canAdminEvent: async () => over.allowed ?? true,
    serviceClient: db,
    storageBucket: 'media',
    publicUrl: (p) => `https://pub.example/${p}`,
    runRefs: vi.fn(async (urls, prompt) => { calls.push({ urls, prompt }); return over.fail ? { ok: false, error: 'provider_error' } : { ok: true, image: new Uint8Array([1]), contentType: 'image/jpeg' }; }),
    logger,
    concurrency: 8,
  });
  return { routes, state, calls };
};
const flush = () => new Promise((r) => setTimeout(r, 30));
const dir = `event/${EVENT}/key-people/`;

describe('booth examples', () => {
  it('makes one picture per look, from the key people, and points the theme at them', async () => {
    const { routes, state, calls } = setup([
      { name: 'Dan', photos: [`${dir}a.jpg`, `${dir}b.jpg`] },
      { name: 'Sarah', photos: [`${dir}c.jpg`] },
    ]);
    const res = mockRes();
    await routes.start({ params: { eventId: EVENT } }, res);
    expect(res.statusCode).toBe(202);
    await flush();
    const looks = BOOTH_ERAS.flatMap((e) => e.looks).length;
    expect(calls).toHaveLength(looks);
    expect(calls[0].urls).toEqual([`https://pub.example/${dir}a.jpg`, `https://pub.example/${dir}b.jpg`, `https://pub.example/${dir}c.jpg`]);
    expect(calls[0].prompt).toMatch(/images 1 to 2 show Dan; image 3 shows Sarah/);
    const theme = JSON.parse(state.uploads[`event/${EVENT}/booth-theme/theme.json`]);
    expect(theme.eras['1980s'].samples['top-gun']).toMatch(/^sample-top-gun-[a-z0-9]+\.jpg$/);
    // Eras the theme has no booth for are left out of it.
    expect(theme.eras['1950s']).toBeUndefined();
    const status = mockRes();
    await routes.status({ params: { eventId: EVENT } }, status);
    expect(status.body.job).toMatchObject({ state: 'done', total: looks, done: looks, failed: 0 });
  });

  // Paths come from a table an admin writes; only the event's own folder
  // may reach the model.
  it('sends only photos from the event\'s own key-people folder', async () => {
    const { routes, calls } = setup([
      { name: 'Dan', photos: [`${dir}a.jpg`, 'event/other-event/key-people/x.jpg', `${dir}../../secret.jpg`, 'https://evil.example/x.jpg'] },
    ]);
    await routes.start({ params: { eventId: EVENT } }, mockRes());
    await flush();
    expect(calls[0].urls).toEqual([`https://pub.example/${dir}a.jpg`]);
  });

  it('refuses without key people, and without admin rights', async () => {
    const none = mockRes();
    await setup([]).routes.start({ params: { eventId: EVENT } }, none);
    expect(none.statusCode).toBe(400);
    const denied = mockRes();
    const s = setup([{ name: 'Dan', photos: [`${dir}a.jpg`] }], { allowed: false });
    await s.routes.start({ params: { eventId: EVENT } }, denied);
    expect(denied.statusCode).toBe(403);
    expect(s.calls).toHaveLength(0);
  });

  it('keeps the old samples when every picture fails', async () => {
    const { routes, state } = setup([{ name: 'Dan', photos: [`${dir}a.jpg`] }], { fail: true });
    await routes.start({ params: { eventId: EVENT } }, mockRes());
    await flush();
    const theme = JSON.parse(state.uploads[`event/${EVENT}/booth-theme/theme.json`]);
    expect(theme.eras['1980s'].samples['top-gun']).toBe('old.jpg');
  });
});

describe('pickReferences', () => {
  it('shares ten references fairly', () => {
    const p = (n, k) => ({ name: n, photos: Array.from({ length: k }, (_, i) => `${n}${i}`) });
    const r = pickReferences([p('a', 5), p('b', 5), p('c', 5)]);
    expect(r.map((x) => x.photos.length)).toEqual([4, 3, 3]);
    expect(pickReferences([p('a', 2)])[0].photos).toHaveLength(2);
  });
});
