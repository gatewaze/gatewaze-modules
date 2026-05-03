/**
 * Smoke tests for the admin route factory.
 *
 * The handlers compose pure validators that have their own unit tests; here
 * we verify the security-critical wiring:
 *
 *   1. Unauthenticated requests are rejected with 401.
 *   2. Mass-assignment fields (created_by, version, published_version, content
 *      on html sites) never reach the Supabase client.
 *   3. The minted preview-token cleartext is returned ONCE in the response
 *      and never appears in the inserted row.
 *   4. The batch endpoint refuses theme_kind='email' sites with 409.
 *   5. Validation errors come back as structured 400 responses (not 500).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createAdminRoutes, type AdminRoutesDeps, type AdminSupabaseClient } from '../admin.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  values?: Record<string, unknown> | Record<string, unknown>[];
  filters: Array<{ col: string; val: unknown }>;
}

interface FakeRpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface FakeSupabaseScripts {
  /** What `.single()` / `.maybeSingle()` / `await` should resolve with for each (table, op) call (in order). */
  queryResults: Array<{ data: unknown; error: { message: string } | null }>;
  /** What `.rpc()` calls should resolve with (in order). */
  rpcResults: Array<{ data: unknown; error: { message: string } | null }>;
}

function makeFakeSupabase(scripts: FakeSupabaseScripts): {
  client: AdminSupabaseClient;
  calls: RecordedCall[];
  rpcCalls: FakeRpcCall[];
} {
  const calls: RecordedCall[] = [];
  const rpcCalls: FakeRpcCall[] = [];
  let queryIdx = 0;
  let rpcIdx = 0;

  const buildQuery = (call: RecordedCall) => {
    const q = {
      select: (_cols: string) => q,
      insert: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        call.op = 'insert';
        call.values = values;
        return q;
      },
      update: (values: Record<string, unknown>) => {
        call.op = 'update';
        call.values = values;
        return q;
      },
      delete: () => {
        call.op = 'delete';
        return q;
      },
      eq: (col: string, val: unknown) => {
        call.filters.push({ col, val });
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        call.filters.push({ col, val: vals });
        return q;
      },
      single: async <T>() => {
        const r = scripts.queryResults[queryIdx++] ?? { data: null, error: { message: 'no script result' } };
        return r as { data: T | null; error: { message: string } | null };
      },
      maybeSingle: async <T>() => {
        const r = scripts.queryResults[queryIdx++] ?? { data: null, error: null };
        return r as { data: T | null; error: { message: string } | null };
      },
      then: (onfulfilled: (v: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }) => unknown) => {
        const r = scripts.queryResults[queryIdx++] ?? { data: [], error: null };
        return Promise.resolve(onfulfilled(r as { data: Array<Record<string, unknown>> | null; error: { message: string } | null }));
      },
    };
    return q;
  };

  const client: AdminSupabaseClient = {
    from(table: string) {
      const call: RecordedCall = { table, op: 'select', filters: [] };
      calls.push(call);
      return buildQuery(call) as ReturnType<AdminSupabaseClient['from']>;
    },
    async rpc(fn, args) {
      rpcCalls.push({ fn, args });
      const r = scripts.rpcResults[rpcIdx++] ?? { data: null, error: { message: 'no script result' } };
      return r;
    },
  };
  return { client, calls, rpcCalls };
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    body: undefined,
    params: {},
    query: {},
    headers: {},
    header: () => undefined,
    ...overrides,
  } as unknown as Request;
}

function fakeRes(): Response & { _status?: number; _body?: unknown } {
  const res: Partial<Response> & { _status?: number; _body?: unknown } = {};
  res.setHeader = vi.fn() as unknown as Response['setHeader'];
  res.status = ((code: number) => {
    (res as { _status?: number })._status = code;
    return res as Response;
  }) as Response['status'];
  res.json = ((body: unknown) => {
    (res as { _body?: unknown })._body = body;
    return res as Response;
  }) as Response['json'];
  return res as Response & { _status?: number; _body?: unknown };
}

const baseDeps = (overrides: Partial<AdminRoutesDeps> = {}): AdminRoutesDeps => ({
  supabase: makeFakeSupabase({ queryResults: [], rpcResults: [] }).client,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getUserId: () => 'user-1',
  ...overrides,
});

const UUID = '00000000-1111-2222-3333-444444444444';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAdminRoutes — auth gating', () => {
  it('rejects createPage without a session (401)', async () => {
    const routes = createAdminRoutes(baseDeps({ getUserId: () => null }));
    const res = fakeRes();
    await routes.createPage(fakeReq({ body: {} }), res);
    expect(res._status).toBe(401);
  });

  it('rejects updatePage without a session (401)', async () => {
    const routes = createAdminRoutes(baseDeps({ getUserId: () => null }));
    const res = fakeRes();
    await routes.updatePage(fakeReq({ body: {}, params: { pageId: UUID } }), res);
    expect(res._status).toBe(401);
  });

  it('rejects createPreviewToken without a session (401)', async () => {
    const routes = createAdminRoutes(baseDeps({ getUserId: () => null }));
    const res = fakeRes();
    await routes.createPreviewToken(fakeReq({ body: {}, params: { pageId: UUID } }), res);
    expect(res._status).toBe(401);
  });
});

describe('createAdminRoutes — createPage', () => {
  it('returns a 400 with field+reason on shape errors', async () => {
    const routes = createAdminRoutes(baseDeps());
    const res = fakeRes();
    await routes.createPage(
      fakeReq({ body: { host_kind: 'site', templates_library_id: 'not-a-uuid' } }),
      res,
    );
    expect(res._status).toBe(400);
    const body = res._body as { error: { code: string; message: string; details?: { field?: string } } };
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.details?.field).toBe('templates_library_id');
  });

  it('drops mass-assignment fields before insert', async () => {
    const fake = makeFakeSupabase({
      queryResults: [{
        data: {
          id: UUID, host_kind: 'site', host_id: UUID, full_path: '/about', slug: 'about',
          title: 'About', status: 'draft', version: 1, published_version: 0,
        },
        error: null,
      }],
      rpcResults: [],
    });
    const routes = createAdminRoutes(baseDeps({ supabase: fake.client }));
    const res = fakeRes();
    await routes.createPage(
      fakeReq({
        body: {
          host_kind: 'site',
          host_id: UUID,
          templates_library_id: UUID,
          slug: 'about', title: 'About', full_path: '/about',
          // Mass-assignment attempts:
          created_by: 'evil-user',
          version: 999,
          published_version: 999,
          content: { hero: 'pwn' },
          content_schema_version: 99,
        },
      }),
      res,
    );
    expect(res._status).toBe(201);
    expect(fake.calls).toHaveLength(1);
    const inserted = fake.calls[0]?.values as Record<string, unknown> | undefined;
    expect(inserted).toBeDefined();
    expect(inserted!['created_by']).toBe('user-1');     // server set, NOT 'evil-user'
    expect(inserted!).not.toHaveProperty('version');
    expect(inserted!).not.toHaveProperty('published_version');
    expect(inserted!).not.toHaveProperty('content');
    expect(inserted!).not.toHaveProperty('content_schema_version');
  });
});

describe('createAdminRoutes — createPreviewToken', () => {
  it('returns the cleartext token ONCE; only the hash hits the DB', async () => {
    const fake = makeFakeSupabase({
      queryResults: [{
        data: { id: UUID, expires_at: '2026-05-02T00:00:00.000Z' },
        error: null,
      }],
      rpcResults: [],
    });
    const routes = createAdminRoutes(baseDeps({ supabase: fake.client }));
    const res = fakeRes();
    await routes.createPreviewToken(
      fakeReq({ body: { ttlSeconds: 3600 }, params: { pageId: UUID } }),
      res,
    );
    expect(res._status).toBe(201);
    const body = res._body as { id: string; token: string; expiresAt: string };
    expect(body.token).toMatch(/^gw_preview_[A-Z0-9]+$/i);
    expect(body.id).toBe(UUID);

    const inserted = fake.calls[0]?.values as Record<string, unknown> | undefined;
    expect(inserted).toBeDefined();
    expect(inserted!).toHaveProperty('token_hash');
    expect(inserted!).not.toHaveProperty('token');
    expect(inserted!['token_hash']).not.toBe(body.token);  // hash, not cleartext
  });

  it('rejects ttlSeconds above the hard cap (400)', async () => {
    const routes = createAdminRoutes(baseDeps());
    const res = fakeRes();
    await routes.createPreviewToken(
      fakeReq({ body: { ttlSeconds: 60 * 60 * 24 * 365 }, params: { pageId: UUID } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('rejects ttlSeconds <= 0 (400)', async () => {
    const routes = createAdminRoutes(baseDeps());
    const res = fakeRes();
    await routes.createPreviewToken(
      fakeReq({ body: { ttlSeconds: 0 }, params: { pageId: UUID } }),
      res,
    );
    expect(res._status).toBe(400);
  });
});

describe('createAdminRoutes — batchSaveContent', () => {
  it('refuses email-kind sites with 409', async () => {
    const fake = makeFakeSupabase({
      queryResults: [{
        data: { id: UUID, theme_kind: 'email' },
        error: null,
      }],
      rpcResults: [],
    });
    const routes = createAdminRoutes(baseDeps({ supabase: fake.client }));
    const res = fakeRes();
    await routes.batchSaveContent(
      fakeReq({
        params: { siteSlug: 'aaif' },
        body: { drafts: [{ route: '/', content: { title: 'X' }, schemaVersion: 1 }] },
      }),
      res,
    );
    expect(res._status).toBe(409);
    expect(fake.rpcCalls).toHaveLength(0);  // nothing dispatched
  });

  it('forwards normalized drafts to the RPC for website sites', async () => {
    const fake = makeFakeSupabase({
      queryResults: [{
        data: { id: UUID, theme_kind: 'website' },
        error: null,
      }],
      rpcResults: [{
        data: [{ route: '/', page_id: UUID, draft_id: UUID, version: 7 }],
        error: null,
      }],
    });
    const routes = createAdminRoutes(baseDeps({ supabase: fake.client }));
    const res = fakeRes();
    await routes.batchSaveContent(
      fakeReq({
        params: { siteSlug: 'aaif' },
        body: { drafts: [{ route: '//', content: { hero: 'X' }, schemaVersion: 2 }] },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0]?.fn).toBe('sites_admin_save_drafts');
    const args = fake.rpcCalls[0]?.args as { p_drafts: Array<{ route: string }> };
    expect(args.p_drafts[0]?.route).toBe('/');   // normalized from '//'
    const body = res._body as { saved: Array<{ route: string; page_id: string }> };
    expect(body.saved[0]?.page_id).toBe(UUID);
  });

  it('returns 400 with index/field on duplicate-route batch', async () => {
    const routes = createAdminRoutes(baseDeps());
    const res = fakeRes();
    await routes.batchSaveContent(
      fakeReq({
        params: { siteSlug: 'aaif' },
        body: {
          drafts: [
            { route: '/about', content: {}, schemaVersion: 1 },
            { route: '//about/', content: {}, schemaVersion: 1 }, // normalizes to /about
          ],
        },
      }),
      res,
    );
    expect(res._status).toBe(400);
    const body = res._body as { error: { code: string; details?: { index?: number; field?: string } } };
    expect(body.error.details?.index).toBe(1);
    expect(body.error.details?.field).toBe('route');
  });
});
