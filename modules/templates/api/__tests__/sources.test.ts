/**
 * Smoke tests for the templates_sources HTTP routes (§6.9).
 *
 * Covers:
 *   - validateCreateSourceInput rejects invalid input shapes
 *   - createSource returns 201 for inline + 501 for git (not implemented)
 *   - getSource / pause / unpause work against scripted Supabase
 *   - mass-assignment fields outside TEMPLATES_SOURCES_WRITE_FIELDS never
 *     reach the Supabase client
 *   - listBlockDefs sanitises the `key` query param (PostgREST injection
 *     guard per §10.5)
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  createSourcesRoutes,
  validateCreateSourceInput,
  type SourcesRoutesDeps,
  type SourcesSupabaseClient,
} from '../sources.js';

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

function makeFakeSupabase(scripts: {
  queryResults: Array<{ data: unknown; error: { message: string } | null }>;
  rpcResults: Array<{ data: unknown; error: { message: string } | null }>;
}): {
  client: SourcesSupabaseClient;
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
      eq: (col: string, val: unknown) => {
        call.filters.push({ col, val });
        return q;
      },
      order: (_col: string, _opts: { ascending: boolean }) => q,
      limit: (_n: number) => q,
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

  const client: SourcesSupabaseClient = {
    from(table: string) {
      const call: RecordedCall = { table, op: 'select', filters: [] };
      calls.push(call);
      return buildQuery(call) as ReturnType<SourcesSupabaseClient['from']>;
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

const baseDeps = (overrides: Partial<SourcesRoutesDeps> = {}): SourcesRoutesDeps => ({
  supabase: makeFakeSupabase({ queryResults: [], rpcResults: [] }).client,
  canAdminLibrary: async () => true,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getUserId: () => 'user-1',
  ...overrides,
});

const LIBRARY_ID = '00000000-1111-2222-3333-444444444444';
const SOURCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe('validateCreateSourceInput', () => {
  it('rejects non-object body', () => {
    expect(validateCreateSourceInput(null).ok).toBe(false);
    expect(validateCreateSourceInput('hi').ok).toBe(false);
    expect(validateCreateSourceInput([]).ok).toBe(false);
  });

  it('requires library_id as a uuid', () => {
    const r = validateCreateSourceInput({ kind: 'inline', label: 'x', inline_html: '<p/>' });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('library_id');
  });

  it('rejects unknown kind', () => {
    const r = validateCreateSourceInput({ library_id: LIBRARY_ID, kind: 'mystery', label: 'x', inline_html: '<p/>' });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('kind');
  });

  it('rejects empty label', () => {
    const r = validateCreateSourceInput({ library_id: LIBRARY_ID, kind: 'inline', label: '', inline_html: '<p/>' });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('label');
  });

  it('rejects git source with non-http url', () => {
    const r = validateCreateSourceInput({
      library_id: LIBRARY_ID,
      kind: 'git',
      label: 'evil',
      url: 'file:///etc/passwd',
    });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('url');
  });

  it('rejects git source with path-traversal in manifest_path', () => {
    const r = validateCreateSourceInput({
      library_id: LIBRARY_ID,
      kind: 'git',
      label: 'theme',
      url: 'https://github.com/x/y',
      manifest_path: '../../../etc/passwd',
    });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('manifest_path');
  });

  it('accepts valid inline source', () => {
    const r = validateCreateSourceInput({
      library_id: LIBRARY_ID,
      kind: 'inline',
      label: 'My inline',
      inline_html: '<p>hi</p>',
    });
    expect(r.ok).toBe(true);
  });

  it('accepts valid git source with branch', () => {
    const r = validateCreateSourceInput({
      library_id: LIBRARY_ID,
      kind: 'git',
      label: 'theme',
      url: 'https://github.com/owner/repo.git',
      branch: 'main',
      manifest_path: 'theme.json',
    });
    expect(r.ok).toBe(true);
  });

  it('strips fields outside TEMPLATES_SOURCES_WRITE_FIELDS allowlist', () => {
    const r = validateCreateSourceInput({
      library_id: LIBRARY_ID,
      kind: 'inline',
      label: 'ok',
      inline_html: '<p/>',
      // Mass-assignment attempt: caller tries to set internal fields.
      created_by: 'attacker',
      status: 'active',
      last_applied_sha: 'feedface',
      id: 'forced-id',
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBeDefined();
    if (r.value) {
      expect(r.value['created_by']).toBeUndefined();
      expect(r.value['status']).toBeUndefined();
      expect(r.value['last_applied_sha']).toBeUndefined();
      expect(r.value['id']).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

describe('createSourcesRoutes — auth gating', () => {
  it('returns 401 on createSource without a session', async () => {
    const routes = createSourcesRoutes(baseDeps({ getUserId: () => null }));
    const res = fakeRes();
    await routes.createSource(fakeReq({ body: {} }), res);
    expect(res._status).toBe(401);
  });

  it('returns 401 on getSource without a session', async () => {
    const routes = createSourcesRoutes(baseDeps({ getUserId: () => null }));
    const res = fakeRes();
    await routes.getSource(fakeReq({ params: { id: SOURCE_ID } }), res);
    expect(res._status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Routes — happy-path + error envelopes
// ---------------------------------------------------------------------------

describe('createSourcesRoutes — createSource', () => {
  it('attempts git ingest for kind=git (no longer 501)', async () => {
    // The git path now shells out to `git clone` — exercising it would require
    // either a real network or a local fixture repo, both of which are out of
    // scope for this unit test. Here we just verify the route does NOT return
    // 501 any more — the deeper ingest behaviour is covered by the git lib's
    // own tests + the integration suite. Expect a 5xx as ingestGit attempts
    // to reach an unreachable URL; never a 501.
    const { client } = makeFakeSupabase({ queryResults: [], rpcResults: [] });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.createSource(
      fakeReq({
        body: {
          library_id: LIBRARY_ID,
          kind: 'git',
          label: 'theme',
          // Use a syntactically-valid URL that will definitely fail to clone
          // (RFC 6761 — `.invalid` TLD is reserved for testing) so the route
          // exits via the catch path, not via 501.
          url: 'https://example.invalid/owner/repo.git',
        },
      }),
      res,
    );
    expect(res._status).not.toBe(501);
    expect(res._status).toBe(500);
  });

  it('returns 400 with structured envelope on validation error', async () => {
    const routes = createSourcesRoutes(baseDeps());
    const res = fakeRes();
    await routes.createSource(fakeReq({ body: { kind: 'inline' } }), res);
    expect(res._status).toBe(400);
    const body = res._body as { error: { code: string; message: string; details?: { field: string } } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.field).toBe('library_id');
  });
});

describe('createSourcesRoutes — getSource', () => {
  it('returns 404 when source does not exist', async () => {
    const { client } = makeFakeSupabase({
      queryResults: [{ data: null, error: null }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.getSource(fakeReq({ params: { id: SOURCE_ID } }), res);
    expect(res._status).toBe(404);
  });

  it('returns 200 with source row when found', async () => {
    const { client } = makeFakeSupabase({
      queryResults: [{
        data: { id: SOURCE_ID, library_id: LIBRARY_ID, kind: 'inline', label: 'My inline', status: 'active' },
        error: null,
      }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.getSource(fakeReq({ params: { id: SOURCE_ID } }), res);
    expect(res._status).toBe(200);
    const body = res._body as { source: { id: string }; preview: null; recent_audit: unknown[] };
    expect(body.source.id).toBe(SOURCE_ID);
    expect(body.preview).toBeNull();
  });

  it('returns 400 when id is not a uuid', async () => {
    const routes = createSourcesRoutes(baseDeps());
    const res = fakeRes();
    await routes.getSource(fakeReq({ params: { id: 'not-a-uuid' } }), res);
    expect(res._status).toBe(400);
  });
});

describe('createSourcesRoutes — checkSource', () => {
  it('attempts upstream probe for git kind (502 on unreachable host)', async () => {
    const { client } = makeFakeSupabase({
      queryResults: [{
        data: {
          id: SOURCE_ID,
          kind: 'git',
          status: 'active',
          url: 'https://example.invalid/owner/repo.git',
          branch: null,
          manifest_path: null,
          last_applied_sha: null,
        },
        error: null,
      }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.checkSource(fakeReq({ params: { id: SOURCE_ID } }), res);
    // Either 502 (clone failed) or 500 (other) — what matters is that we
    // do NOT short-circuit at 501 any more.
    expect(res._status).not.toBe(501);
  });

  it('returns 500 for git source with no url stored (data integrity)', async () => {
    const { client } = makeFakeSupabase({
      queryResults: [{
        data: { id: SOURCE_ID, kind: 'git', status: 'active', url: null, branch: null, manifest_path: null, last_applied_sha: null },
        error: null,
      }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.checkSource(fakeReq({ params: { id: SOURCE_ID } }), res);
    expect(res._status).toBe(500);
  });

  it('returns 200 with no preview for inline (never drifts)', async () => {
    const { client } = makeFakeSupabase({
      queryResults: [{ data: { id: SOURCE_ID, kind: 'inline', status: 'active' }, error: null }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.checkSource(fakeReq({ params: { id: SOURCE_ID } }), res);
    expect(res._status).toBe(200);
    const body = res._body as { preview: null };
    expect(body.preview).toBeNull();
  });
});

describe('createSourcesRoutes — updateSource validation', () => {
  it.each([
    [{ manifest_path: '../outside' }, 'manifest_path'],
    [{ manifest_path: '/abs' }, 'manifest_path'],
    [{ branch: 'main; rm -rf /' }, 'branch'],
  ])('rejects %j before writing (the value feeds the clone and the on-disk walk)', async (body, field) => {
    const { client, calls } = makeFakeSupabase({
      // Only the ownership lookup should run.
      queryResults: [{ data: { library_id: LIBRARY_ID }, error: null }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.updateSource(fakeReq({ params: { id: SOURCE_ID }, body }), res);
    expect(res._status).toBe(400);
    expect((res._body as { error: { details: { field: string } } }).error.details.field).toBe(field);
    expect(calls.find((c) => c.op === 'update')).toBeUndefined();
  });
});

describe('createSourcesRoutes — pause / unpause', () => {
  it('pauseSource flips status=paused on the row', async () => {
    const { client, calls } = makeFakeSupabase({
      // The ownership lookup runs first, then the update.
      queryResults: [{ data: { library_id: LIBRARY_ID }, error: null }, { data: { id: SOURCE_ID, status: 'paused' }, error: null }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.pauseSource(fakeReq({ params: { id: SOURCE_ID } }), res);
    expect(res._status).toBe(200);
    // The ownership lookup is calls[0]; the status write follows it.
    const write = calls.find((c) => c.op === 'update');
    expect(write?.values).toEqual({ status: 'paused' });
  });

  it('unpauseSource flips status=active on the row', async () => {
    const { client, calls } = makeFakeSupabase({
      // The ownership lookup runs first, then the update.
      queryResults: [{ data: { library_id: LIBRARY_ID }, error: null }, { data: { id: SOURCE_ID, status: 'active' }, error: null }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.unpauseSource(fakeReq({ params: { id: SOURCE_ID } }), res);
    expect(res._status).toBe(200);
    const write = calls.find((c) => c.op === 'update');
    expect(write?.values).toEqual({ status: 'active' });
  });
});

describe('createSourcesRoutes — seedFromBoilerplate', () => {
  it('rejects unauthenticated callers (401)', async () => {
    const routes = createSourcesRoutes(baseDeps({ getUserId: () => null }));
    const res = fakeRes();
    await routes.seedFromBoilerplate(fakeReq({ params: { id: LIBRARY_ID }, body: { host_kind: 'newsletter' } }), res);
    expect(res._status).toBe(401);
  });

  it('rejects invalid host_kind (400)', async () => {
    const routes = createSourcesRoutes(baseDeps());
    const res = fakeRes();
    await routes.seedFromBoilerplate(fakeReq({ params: { id: LIBRARY_ID }, body: { host_kind: 'mystery' } }), res);
    expect(res._status).toBe(400);
  });

  it('rejects when library already has a source (409 source_conflict)', async () => {
    const { client } = makeFakeSupabase({
      // existing source check returns a row
      queryResults: [{ data: { id: SOURCE_ID }, error: null }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.seedFromBoilerplate(fakeReq({ params: { id: LIBRARY_ID }, body: { host_kind: 'newsletter' } }), res);
    expect(res._status).toBe(409);
    const body = res._body as { error: { code: string } };
    expect(body.error.code).toBe('source_conflict');
  });

  it('rejects invalid library id (400)', async () => {
    const routes = createSourcesRoutes(baseDeps());
    const res = fakeRes();
    await routes.seedFromBoilerplate(fakeReq({ params: { id: 'not-a-uuid' }, body: { host_kind: 'newsletter' } }), res);
    expect(res._status).toBe(400);
  });
});

describe('createSourcesRoutes — listBlockDefs (PostgREST injection guard)', () => {
  it('strips filter metacharacters from the key query param (§10.5)', async () => {
    const { client, calls } = makeFakeSupabase({
      queryResults: [{ data: [], error: null }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.listBlockDefs(
      fakeReq({
        params: { id: LIBRARY_ID },
        query: { key: 'evil,or(1=1)*\\' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    // The eq filter recorded for `key` MUST have the metacharacters stripped.
    // Input: 'evil,or(1=1)*\\' — strip [,()*\\] → 'evilor1=1' (= and digits remain).
    const keyFilter = calls[0]?.filters.find((f) => f.col === 'key');
    expect(keyFilter?.val).toBe('evilor1=1');
    // None of the dangerous PostgREST filter metacharacters survive.
    expect(keyFilter?.val as string).not.toMatch(/[,()*\\]/);
  });

  it('caps the key query param at 100 chars', async () => {
    const long = 'a'.repeat(500);
    const { client, calls } = makeFakeSupabase({
      queryResults: [{ data: [], error: null }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    const res = fakeRes();
    await routes.listBlockDefs(
      fakeReq({ params: { id: LIBRARY_ID }, query: { key: long } }),
      res,
    );
    const keyFilter = calls[0]?.filters.find((f) => f.col === 'key');
    expect((keyFilter?.val as string).length).toBe(100);
  });

  it('hides inactive defs by default, includes when ?include_inactive=true', async () => {
    const { client, calls } = makeFakeSupabase({
      queryResults: [{ data: [], error: null }],
      rpcResults: [],
    });
    const routes = createSourcesRoutes(baseDeps({ supabase: client }));
    await routes.listBlockDefs(fakeReq({ params: { id: LIBRARY_ID }, query: {} }), fakeRes());
    expect(calls[0]?.filters.some((f) => f.col === 'is_current' && f.val === true)).toBe(true);

    const { client: c2, calls: calls2 } = makeFakeSupabase({
      queryResults: [{ data: [], error: null }],
      rpcResults: [],
    });
    const routes2 = createSourcesRoutes(baseDeps({ supabase: c2 }));
    await routes2.listBlockDefs(
      fakeReq({ params: { id: LIBRARY_ID }, query: { include_inactive: 'true' } }),
      fakeRes(),
    );
    expect(calls2[0]?.filters.some((f) => f.col === 'is_current')).toBe(false);
  });
});

describe('createSourcesRoutes — cloneSource (reuse a connected repo)', () => {
  const GIT_SOURCE = {
    id: SOURCE_ID,
    library_id: '99999999-9999-9999-9999-999999999999',
    kind: 'git',
    status: 'active',
    label: 'Template repo',
    url: 'https://example.invalid/owner/repo.git',
    branch: 'main',
    manifest_path: null,
    token_secret_ref: 'ghp_secret',
  };

  it('returns 401 without a session', async () => {
    const routes = createSourcesRoutes(baseDeps({ getUserId: () => null }));
    const res = fakeRes();
    await routes.cloneSource(fakeReq({ params: { id: SOURCE_ID }, body: { library_id: LIBRARY_ID } }), res);
    expect(res._status).toBe(401);
  });

  it('validates the ids before touching the database', async () => {
    const routes = createSourcesRoutes(baseDeps());
    const res = fakeRes();
    await routes.cloneSource(fakeReq({ params: { id: 'nope' }, body: { library_id: LIBRARY_ID } }), res);
    expect(res._status).toBe(400);
    const res2 = fakeRes();
    await routes.cloneSource(fakeReq({ params: { id: SOURCE_ID }, body: { library_id: 'nope' } }), res2);
    expect(res2._status).toBe(400);
    expect((res2._body as { error: { details?: { field: string } } }).error.details?.field).toBe('library_id');
  });

  it('refuses an unknown source, a non-git source, and cloning into the same library', async () => {
    const missing = createSourcesRoutes(baseDeps({ supabase: makeFakeSupabase({ queryResults: [{ data: null, error: null }], rpcResults: [] }).client }));
    const r1 = fakeRes();
    await missing.cloneSource(fakeReq({ params: { id: SOURCE_ID }, body: { library_id: LIBRARY_ID } }), r1);
    expect(r1._status).toBe(404);

    const upload = createSourcesRoutes(baseDeps({ supabase: makeFakeSupabase({ queryResults: [{ data: { ...GIT_SOURCE, kind: 'upload', url: null }, error: null }], rpcResults: [] }).client }));
    const r2 = fakeRes();
    await upload.cloneSource(fakeReq({ params: { id: SOURCE_ID }, body: { library_id: LIBRARY_ID } }), r2);
    expect(r2._status).toBe(400);

    const same = createSourcesRoutes(baseDeps({ supabase: makeFakeSupabase({ queryResults: [{ data: { ...GIT_SOURCE, library_id: LIBRARY_ID }, error: null }], rpcResults: [] }).client }));
    const r3 = fakeRes();
    await same.cloneSource(fakeReq({ params: { id: SOURCE_ID }, body: { library_id: LIBRARY_ID } }), r3);
    expect(r3._status).toBe(400);
  });

  it('refuses a target library that does not exist', async () => {
    const routes = createSourcesRoutes(baseDeps({ supabase: makeFakeSupabase({ queryResults: [{ data: GIT_SOURCE, error: null }, { data: null, error: null }], rpcResults: [] }).client }));
    const res = fakeRes();
    await routes.cloneSource(fakeReq({ params: { id: SOURCE_ID }, body: { library_id: LIBRARY_ID } }), res);
    expect(res._status).toBe(404);
  });

  it('hands the copied connection to the git ingest and surfaces a clone failure as 502, never leaking the token', async () => {
    // `.invalid` is reserved (RFC 6761), so the clone fails and the route
    // exits through its catch path — the same shape createSource relies on.
    const routes = createSourcesRoutes(baseDeps({ supabase: makeFakeSupabase({ queryResults: [{ data: GIT_SOURCE, error: null }, { data: { id: LIBRARY_ID }, error: null }], rpcResults: [] }).client }));
    const res = fakeRes();
    await routes.cloneSource(fakeReq({ params: { id: SOURCE_ID }, body: { library_id: LIBRARY_ID, label: 'Reused repo' } }), res);
    expect(res._status).toBe(502);
    expect(JSON.stringify(res._body)).not.toContain('ghp_secret');
  });
});

describe('createSourcesRoutes — library authorization', () => {
  it('createSource answers 403 when the caller does not administer the target library', async () => {
    const routes = createSourcesRoutes(baseDeps({ canAdminLibrary: async () => false }));
    const res = fakeRes();
    await routes.createSource(fakeReq({ body: { library_id: LIBRARY_ID, kind: 'git', label: 'theme', url: 'https://example.invalid/owner/repo.git' } }), res);
    expect(res._status).toBe(403);
  });

  it('cloneSource answers 403 for either end the caller does not administer, before any ingest', async () => {
    const source = { id: SOURCE_ID, library_id: '99999999-9999-9999-9999-999999999999', kind: 'git', status: 'active', label: 'Template repo', url: 'https://example.invalid/owner/repo.git', branch: 'main', manifest_path: null, token_secret_ref: 'ghp_secret' };
    const seen: string[] = [];
    const routes = createSourcesRoutes(baseDeps({
      supabase: makeFakeSupabase({ queryResults: [{ data: source, error: null }], rpcResults: [] }).client,
      canAdminLibrary: async (_req, id) => { seen.push(id); return id !== source.library_id; },
    }));
    const res = fakeRes();
    await routes.cloneSource(fakeReq({ params: { id: SOURCE_ID }, body: { library_id: LIBRARY_ID } }), res);
    expect(res._status).toBe(403);
    expect(seen).toEqual([source.library_id]);
  });

  it('fails closed when the authorization check itself throws', async () => {
    const routes = createSourcesRoutes(baseDeps({ canAdminLibrary: async () => { throw new Error('db down'); } }));
    const res = fakeRes();
    await routes.createSource(fakeReq({ body: { library_id: LIBRARY_ID, kind: 'git', label: 'theme', url: 'https://example.invalid/owner/repo.git' } }), res);
    expect(res._status).toBe(403);
  });
});
