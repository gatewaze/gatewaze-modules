// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { createAdminMediaRoutes } from '../admin-media-routes.js';
import { CARD_GENRES, CARD_LIMITS, validateCardInput } from '../../lib/card-copy.js';

const EVENT_ID = '99999999-8888-7777-6666-555555555555';
const MEDIA_ID = '44444444-3333-2222-1111-000000000000';

const GOOD_CARD = {
  title: 'Last Orders', words: ['Pints', 'Mates', 'Last Call'],
  kind: 'Series', genre: 'comedy', eyebrow: 'A Picflix Original',
};

function mockRes() {
  const res = {
    statusCode: 200, body: undefined,
    status(s) { res.statusCode = s; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}

/** The service client; `row` is the photo as stored for this event. */
function makeDb({ row = null, readError = null, writeError = null } = {}) {
  const state = { writes: [], reads: 0 };
  const client = {
    from: () => {
      let pending = null;
      const b = {
        select: () => b,
        eq: () => b,
        update: (fields) => { pending = fields; return b; },
        maybeSingle: () => {
          if (pending) {
            state.writes.push(pending);
            if (writeError) return Promise.resolve({ data: null, error: { message: writeError } });
            return Promise.resolve({ data: row ? { id: row.id, metadata: pending.metadata } : null, error: null });
          }
          state.reads++;
          if (readError) return Promise.resolve({ data: null, error: { message: readError } });
          return Promise.resolve({ data: row, error: null });
        },
      };
      return b;
    },
  };
  return { client, state };
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

/** `allowed` is what the caller's own can_admin_host_media answers. */
const call = async (db, { allowed = true, eventId = EVENT_ID, mediaId = MEDIA_ID, body = { card: GOOD_CARD }, asked = [] } = {}) => {
  const routes = createAdminMediaRoutes({
    canAdminEvent: async (_req, ev) => {
      asked.push(ev);
      if (allowed instanceof Error) throw allowed;
      return allowed;
    },
    serviceClient: db,
    logger,
  });
  const res = mockRes();
  await routes.putCard({ params: { eventId, mediaId }, body }, res);
  return res;
};

describe('PUT card', () => {
  const existing = {
    id: MEDIA_ID,
    metadata: { album: 'day', guest_name: 'Sam', hidden: false, client_id: 'c1', card: { title: 'Old' } },
  };

  it('replaces the card and keeps every other metadata field', async () => {
    const { client, state } = makeDb({ row: existing });
    const res = await call(client);
    expect(res.statusCode).toBe(200);
    expect(res.body.card.title).toBe('Last Orders');
    const written = state.writes[0].metadata;
    expect(written.album).toBe('day');
    expect(written.guest_name).toBe('Sam');
    expect(written.client_id).toBe('c1');
    expect(written.card.title).toBe('Last Orders');
  });

  // Mass assignment: the editor must not become a way to rewrite the
  // photo's album, hidden flag or uploader.
  it('ignores anything in the body that is not a card field', async () => {
    const { client, state } = makeDb({ row: existing });
    await call(client, {
      body: {
        card: { ...GOOD_CARD, album: 'evening', hidden: true },
        metadata: { album: 'evening' },
        album: 'evening',
      },
    });
    const written = state.writes[0].metadata;
    expect(written.album).toBe('day');
    expect(written.hidden).toBe(false);
    expect(Object.keys(written.card).sort()).toEqual(['eyebrow', 'genre', 'kind', 'title', 'words']);
  });

  it('writes only the metadata column', async () => {
    const { client, state } = makeDb({ row: existing });
    await call(client);
    expect(Object.keys(state.writes[0])).toEqual(['metadata']);
  });

  // The route uses the service client, so authorisation is everything.
  it('asks whether the caller may administer the event in the path', async () => {
    const { client } = makeDb({ row: existing });
    const asked = [];
    await call(client, { asked });
    expect(asked).toEqual([EVENT_ID]);
  });

  it('refuses a caller who is not an admin of the event, without touching the photo', async () => {
    const { client, state } = makeDb({ row: existing });
    const res = await call(client, { allowed: false });
    expect(res.statusCode).toBe(403);
    expect(state.reads).toBe(0);
    expect(state.writes).toHaveLength(0);
  });

  it('fails closed when the authorisation check throws', async () => {
    const { client, state } = makeDb({ row: existing });
    const res = await call(client, { allowed: new Error('rpc down') });
    expect(res.statusCode).toBe(403);
    expect(state.writes).toHaveLength(0);
  });

  it('answers 401 with no session', async () => {
    const { client, state } = makeDb({ row: existing });
    expect((await call(client, { allowed: null })).statusCode).toBe(401);
    expect(state.writes).toHaveLength(0);
  });

  it('refuses a malformed card without asking or writing', async () => {
    const { client, state } = makeDb({ row: existing });
    const asked = [];
    const res = await call(client, { body: { card: { ...GOOD_CARD, words: ['one', 'two'] } }, asked });
    expect(res.statusCode).toBe(400);
    expect(asked).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  });

  it('rejects ids that are not UUIDs before touching the database', async () => {
    const { client, state } = makeDb({ row: existing });
    expect((await call(client, { eventId: 'x' })).statusCode).toBe(400);
    expect((await call(client, { mediaId: "1' or '1'='1" })).statusCode).toBe(400);
    expect(state.reads).toBe(0);
  });

  // An admin of one event pairing their event id with another event's
  // photo: the read is scoped to the event in the path, so it misses.
  it('answers 404 for a photo that is not in the authorised event', async () => {
    const { client, state } = makeDb({ row: null });
    const res = await call(client);
    expect(res.statusCode).toBe(404);
    expect(state.writes).toHaveLength(0);
  });

  it('reports a failed read or write as a server error', async () => {
    expect((await call(makeDb({ readError: 'boom' }).client)).statusCode).toBe(500);
    expect((await call(makeDb({ row: existing, writeError: 'boom' }).client)).statusCode).toBe(500);
  });
});

describe('validateCardInput', () => {
  it('accepts a well-formed card and trims it', () => {
    const r = validateCardInput({ ...GOOD_CARD, title: '  Last Orders  ' });
    expect(r.ok && r.card.title).toBe('Last Orders');
  });

  it('refuses over-length text rather than silently cutting it', () => {
    const r = validateCardInput({ ...GOOD_CARD, title: 'x'.repeat(CARD_LIMITS.title + 1) });
    expect(r.ok).toBe(false);
  });

  it('allows the title and words at exactly their limits', () => {
    const r = validateCardInput({
      ...GOOD_CARD, title: 'x'.repeat(CARD_LIMITS.title), words: ['w'.repeat(CARD_LIMITS.word), 'b', 'c'],
    });
    expect(r.ok).toBe(true);
  });

  it('requires exactly three non-empty words', () => {
    expect(validateCardInput({ ...GOOD_CARD, words: ['a', 'b'] }).ok).toBe(false);
    expect(validateCardInput({ ...GOOD_CARD, words: ['a', 'b', 'c', 'd'] }).ok).toBe(false);
    expect(validateCardInput({ ...GOOD_CARD, words: ['a', ' ', 'c'] }).ok).toBe(false);
    expect(validateCardInput({ ...GOOD_CARD, words: 'a,b,c' }).ok).toBe(false);
  });

  it('only accepts the known genres and kinds', () => {
    for (const g of CARD_GENRES) expect(validateCardInput({ ...GOOD_CARD, genre: g }).ok).toBe(true);
    expect(validateCardInput({ ...GOOD_CARD, genre: 'documentary' }).ok).toBe(false);
    expect(validateCardInput({ ...GOOD_CARD, kind: 'Movie' }).ok).toBe(false);
  });

  it('allows an empty eyebrow', () => {
    expect(validateCardInput({ ...GOOD_CARD, eyebrow: '' }).ok).toBe(true);
  });

  it('strips control characters that would otherwise reach the screen', () => {
    const r = validateCardInput({ ...GOOD_CARD, title: 'Last  Orders' });
    expect(r.ok && r.card.title).toBe('Last Orders');
  });

  it('refuses a missing or non-object card', () => {
    for (const bad of [undefined, null, 'card', 42, []]) expect(validateCardInput(bad).ok).toBe(false);
  });
});
