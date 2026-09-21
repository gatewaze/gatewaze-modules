// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { createAdminLinksRoutes, LINK_WRITE_FIELDS } from '../admin-links-routes.js';

const EVENT_ID = '99999999-8888-7777-6666-555555555555';
const LINK_ID = '44444444-3333-2222-1111-000000000000';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(s) { res.statusCode = s; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}

function makeUserClient(config = {}) {
  const state = { inserted: [], updated: [], deleted: 0 };
  function builder() {
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      maybeSingle: () => Promise.resolve({ data: config.existing ?? null, error: null }),
      then: (resolve) => resolve({ data: config.listData ?? [], error: null }),
      insert: (row) => {
        state.inserted.push(row);
        return {
          select: () => ({
            single: () => Promise.resolve(
              config.insertError
                ? { data: null, error: config.insertError }
                : { data: { ...row, id: LINK_ID, uploads_count: 0 }, error: null },
            ),
          }),
        };
      },
      update: (fields) => {
        state.updated.push(fields);
        const ub = {
          eq: () => ub,
          select: () => ub,
          maybeSingle: () => Promise.resolve({ data: config.existing ? { ...config.existing, ...fields } : null, error: null }),
          then: (resolve) => resolve({ data: null, error: null }),
        };
        return ub;
      },
      delete: () => {
        state.deleted += 1;
        const db = { eq: () => db, then: (resolve) => resolve({ data: null, error: null }) };
        return db;
      },
    };
    return b;
  }
  return { state, client: { from: () => builder() } };
}

function makeRoutes(config = {}, clientPresent = true) {
  const { state, client } = makeUserClient(config);
  const routes = createAdminLinksRoutes({
    userClient: () => (clientPresent ? client : null),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { routes, state };
}

function req(overrides = {}) {
  return { params: { eventId: EVENT_ID }, body: {}, headers: {}, userId: USER_ID, ...overrides };
}

describe('admin links routes', () => {
  it('rejects a non-UUID event id', async () => {
    const { routes } = makeRoutes();
    const res = mockRes();
    await routes.listLinks(req({ params: { eventId: 'nope' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('401s when no user-scoped client can be built', async () => {
    const { routes } = makeRoutes({}, false);
    const res = mockRes();
    await routes.listLinks(req(), res);
    expect(res.statusCode).toBe(401);
  });

  it('creates a link with a server-generated code and ignores injected fields', async () => {
    const { routes, state } = makeRoutes();
    const res = mockRes();
    await routes.createLink(req({
      body: {
        label: 'Wedding day QR',
        short_code: 'hacker', // not writable
        uploads_count: 999,   // not writable
        event_id: 'other',    // not writable
        auto_approve: false,
      },
    }), res);
    expect(res.statusCode).toBe(201);
    const row = state.inserted[0];
    expect(row.short_code).toMatch(/^[a-z0-9]{10}$/);
    expect(row.event_id).toBe(EVENT_ID);
    expect(row.created_by).toBe(USER_ID);
    expect(row.auto_approve).toBe(false);
    expect(row.uploads_count).toBeUndefined();
  });

  it('requires a label', async () => {
    const { routes } = makeRoutes();
    const res = mockRes();
    await routes.createLink(req({ body: { label: '  ' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('maps an RLS denial to 403', async () => {
    const { routes } = makeRoutes({ insertError: { code: '42501', message: 'new row violates row-level security policy' } });
    const res = mockRes();
    await routes.createLink(req({ body: { label: 'X' } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('patch rejects an empty allowlisted set', async () => {
    const { routes } = makeRoutes();
    const res = mockRes();
    await routes.patchLink(req({ params: { eventId: EVENT_ID, id: LINK_ID }, body: { short_code: 'zzz' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('no_fields');
  });

  it('patch applies only allowlisted fields', async () => {
    const existing = { id: LINK_ID, uploads_count: 3 };
    const { routes, state } = makeRoutes({ existing });
    const res = mockRes();
    await routes.patchLink(req({ params: { eventId: EVENT_ID, id: LINK_ID }, body: { is_active: false, uploads_count: 0 } }), res);
    expect(res.statusCode).toBe(200);
    expect(state.updated[0].is_active).toBe(false);
    expect(state.updated[0].uploads_count).toBeUndefined();
  });

  it('delete deactivates once uploads exist, deletes otherwise', async () => {
    const used = makeRoutes({ existing: { id: LINK_ID, uploads_count: 5 } });
    const res1 = mockRes();
    await used.routes.deleteLink(req({ params: { eventId: EVENT_ID, id: LINK_ID } }), res1);
    expect(res1.body.action).toBe('deactivated');
    expect(used.state.updated[0].is_active).toBe(false);
    expect(used.state.deleted).toBe(0);

    const unused = makeRoutes({ existing: { id: LINK_ID, uploads_count: 0 } });
    const res2 = mockRes();
    await unused.routes.deleteLink(req({ params: { eventId: EVENT_ID, id: LINK_ID } }), res2);
    expect(res2.body.action).toBe('deleted');
    expect(unused.state.deleted).toBe(1);
  });

  it('exposes a frozen allowlist without server-owned columns', () => {
    expect(LINK_WRITE_FIELDS).not.toContain('short_code');
    expect(LINK_WRITE_FIELDS).not.toContain('uploads_count');
    expect(LINK_WRITE_FIELDS).not.toContain('event_id');
    expect(LINK_WRITE_FIELDS).not.toContain('created_by');
  });
});
