import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests with no platform: supabase-js is replaced by an in-memory
 * PostgREST stand-in, the ai runner by a scripted runChat, and the Express
 * app by an object that records each handler.
 */

type Row = Record<string, unknown>;

const ID1 = '11111111-1111-4111-8111-111111111111';
const DRAFT = '99999999-9999-4999-8999-999999999999';

const state = {
  isAdmin: true as boolean,
  adminError: null as { message: string } | null,
  uid: 'u1' as string | null,
  tables: {} as Record<string, Row[]>,
  failInsertOn: null as string | null,
  errorOn: null as string | null,
  calls: [] as string[],
  runChatCalls: 0,
  runnerFails: false,
  lastLimit: 0,
  flipOnUpdate: null as string | null,
};

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let payload: Row | Row[] | null = null;
  let embed = false;
  let limit = Infinity;
  const run = (): { data: unknown; error: unknown } => {
    const rows = state.tables[table];
    if (!rows) return { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } };
    if (state.errorOn === table) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    if (op === 'insert') {
      state.calls.push(`insert ${table}`);
      if (state.failInsertOn === table) return { data: null, error: { message: 'insert failed' } };
      const list = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: r.id ?? DRAFT, status: 'draft', ...r }));
      rows.push(...list);
      return { data: list, error: null };
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === 'delete') {
      state.calls.push(`delete ${table}`);
      state.tables[table] = rows.filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    }
    if (op === 'update') {
      state.calls.push(`update ${table}`);
      // Simulate another writer changing the status between lookup and update.
      if (state.flipOnUpdate) {
        for (const r of rows) r.status = state.flipOnUpdate;
        return { data: rows.filter((r) => filters.every((f) => f(r))), error: null };
      }
      for (const r of hit) Object.assign(r, payload);
    }
    const out = hit.slice(0, limit).map((r) => embed
      ? { ...r, sources: (state.tables.social_post_draft_sources ?? []).filter((s) => s.draft_id === r.id) }
      : r);
    return { data: out, error: null };
  };
  const q = {
    select(cols?: string) { embed = !!cols?.includes('sources:'); return q; },
    insert(p: Row | Row[]) { op = 'insert'; payload = p; return q; },
    update(p: Row) { op = 'update'; payload = p; return q; },
    delete() { op = 'delete'; return q; },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q; },
    neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return q; },
    in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return q; },
    gte() { return q; },
    ilike() { return q; },
    order() { return q; },
    limit(n: number) { limit = n; state.lastLimit = n; return q; },
    async maybeSingle() { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: r.error }; },
    async single() { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: r.error }; },
    then(resolve: (v: unknown) => void) { resolve(run()); },
  };
  return q;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, key: string) => ({
    rpc: async () => ({ data: state.isAdmin, error: state.adminError }),
    auth: { getUser: async () => ({ data: { user: state.uid ? { id: state.uid } : null }, error: null }) },
    from: (table: string) => {
      if (key !== 'service') throw new Error('data reads must use the service client');
      return query(table);
    },
  }),
}));

vi.mock('../lib/generate.js', async (orig) => {
  const real = await orig<typeof import('../lib/generate')>();
  return {
    ...real,
    loadRunChat: async () => {
      if (state.runnerFails) throw new Error('Cannot find module runner');
      return runner;
    },
  };
});

const runner = async () => {
  state.runChatCalls++;
  return {
        structured: { text: 'Hook.\n\nWith @Cisco.\n\nhttps://aaif.io/blog/mcpa/', hashtags: ['MCP', 'AI', 'OpenSource'], mentions: ['Cisco'] },
        model: 'claude-sonnet-5',
        costMicroUsd: 10,
      };
};

const { registerRoutes } = await import('../api/register-routes');

type Handler = (req: unknown, res: unknown) => Promise<void>;

function mount() {
  const h: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, f: Handler) => { h[`${m} ${p}`] = f; };
  registerRoutes({ get: reg('GET'), post: reg('POST'), patch: reg('PATCH') } as never);
  return h;
}

function res() {
  const r = { code: 200, body: undefined as unknown, headers: {} as Record<string, string>, headersSent: false } as {
    code: number; body: unknown; headers: Record<string, string>; headersSent: boolean;
    status: (n: number) => typeof r; json: (b: unknown) => typeof r; setHeader: (k: string, v: string) => void;
  };
  r.status = (n) => { r.code = n; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

const auth = { authorization: 'Bearer t' };
const errCode = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;

beforeEach(() => {
  process.env.SUPABASE_URL = 'http://db.test';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  delete process.env.SITE_URL;
  state.isAdmin = true;
  state.adminError = null;
  state.uid = 'u1';
  state.failInsertOn = null;
  state.errorOn = null;
  state.calls = [];
  state.runChatCalls = 0;
  state.runnerFails = false;
  state.flipOnUpdate = null;
  state.tables = {
    blog_posts: [{ id: ID1, title: 'Introducing the MCPA', canonical_url: 'https://aaif.io/blog/mcpa/', publish_state: 'published', status: 'published', visibility: 'public', content: '<p>Body</p>' }],
    content_keyword_item_state: [{ content_type: 'blog_post', content_id: ID1, matched_rule_ids: ['r1'] }],
    content_keyword_rules: [{ id: 'r1', name: 'Member: Cisco', metadata: { kind: 'membership' } }],
    social_post_drafts: [],
    social_post_draft_sources: [],
  };
});

describe('admin gate', () => {
  it('401 without a bearer token, before any data access', async () => {
    const r = res();
    await mount()['POST /api/admin/social-posts/generate']({ headers: {}, body: {} }, r);
    expect(r.code).toBe(401);
    expect(state.runChatCalls).toBe(0);
  });
  it('403 for a non-admin', async () => {
    state.isAdmin = false;
    const r = res();
    await mount()['GET /api/admin/social-posts/pool']({ headers: auth, query: {} }, r);
    expect(r.code).toBe(403);
  });
  it('500, not 403, when the is_admin check itself fails', async () => {
    state.adminError = { message: 'db down' };
    const r = res();
    await mount()['GET /api/admin/social-posts/drafts']({ headers: auth, query: {} }, r);
    expect(r.code).toBe(500);
  });
  it('401 when the caller cannot be resolved', async () => {
    state.uid = null;
    const r = res();
    await mount()['GET /api/admin/social-posts/drafts']({ headers: auth, query: {} }, r);
    expect(r.code).toBe(401);
  });
});

describe('generate', () => {
  const body = { format: 'announcement', items: [{ content_type: 'blog_post', content_id: ID1 }] };

  it('writes a post from a published item', async () => {
    const r = res();
    await mount()['POST /api/admin/social-posts/generate']({ headers: auth, body }, r);
    expect(r.code).toBe(200);
    expect((r.body as { text: string }).text).toContain('#MCP #AI #OpenSource');
    expect((r.body as { mentions: string[] }).mentions).toEqual(['Cisco']);
  });
  it('400 for a roundup of one, bad instructions, or an unknown format', async () => {
    const h = mount();
    for (const b of [
      { ...body, format: 'roundup' },
      { ...body, instructions: 'x'.repeat(1001) },
      { ...body, instructions: 42 },
      { ...body, format: 'thread' },
    ]) {
      const r = res();
      await h['POST /api/admin/social-posts/generate']({ headers: auth, body: b }, r);
      expect(r.code).toBe(400);
    }
    expect(state.runChatCalls).toBe(0);
  });
  it('404 for an unpublished item, without calling the model', async () => {
    state.tables.blog_posts[0].publish_state = 'pending_review';
    const r = res();
    await mount()['POST /api/admin/social-posts/generate']({ headers: auth, body }, r);
    expect(r.code).toBe(404);
    expect(state.runChatCalls).toBe(0);
  });
  it('500, not 404, when a content table answers with a real error', async () => {
    state.errorOn = 'blog_posts';
    const r = res();
    await mount()['POST /api/admin/social-posts/generate']({ headers: auth, body }, r);
    expect(r.code).toBe(500);
    expect(state.runChatCalls).toBe(0);
  });
  it('429 with Retry-After after 10 drafts in a minute', async () => {
    const h = mount();
    for (let i = 0; i < 10; i++) {
      const r = res();
      await h['POST /api/admin/social-posts/generate']({ headers: auth, body }, r);
      expect(r.code).toBe(200);
    }
    const r = res();
    await h['POST /api/admin/social-posts/generate']({ headers: auth, body }, r);
    expect(r.code).toBe(429);
    expect(Number(r.headers['Retry-After'])).toBeGreaterThan(0);
  });
});

describe('drafts', () => {
  const create = { format: 'announcement', body: 'Hello @Cisco and @Acme', mentions: ['Acme'], sources: [{ content_type: 'blog_post', content_id: ID1 }] };

  it('saves a draft with its sources, deriving mentions on the server', async () => {
    const r = res();
    await mount()['POST /api/admin/social-posts/drafts']({ headers: auth, body: create }, r);
    expect(r.code).toBe(201);
    expect(state.tables.social_post_drafts[0]).toMatchObject({ mentions: ['Cisco'], created_by: 'u1', status: 'draft' });
    expect(state.tables.social_post_draft_sources[0]).toMatchObject({ draft_id: DRAFT, content_type: 'blog_post', title: 'Introducing the MCPA', url: 'https://aaif.io/blog/mcpa/' });
  });
  it('removes the draft when its sources fail to save', async () => {
    state.failInsertOn = 'social_post_draft_sources';
    const r = res();
    await mount()['POST /api/admin/social-posts/drafts']({ headers: auth, body: create }, r);
    expect(r.code).toBe(500);
    expect(state.calls).toContain('delete social_post_drafts');
    expect(state.tables.social_post_drafts).toEqual([]);
  });
  it('lists without archived drafts by default, and rejects an unknown status', async () => {
    state.tables.social_post_drafts.push({ id: 'a', status: 'archived' }, { id: 'b', status: 'ready' });
    const h = mount();
    const r = res();
    await h['GET /api/admin/social-posts/drafts']({ headers: auth, query: {} }, r);
    expect((r.body as { drafts: Row[] }).drafts.map((d) => d.id)).toEqual(['b']);
    const bad = res();
    await h['GET /api/admin/social-posts/drafts']({ headers: auth, query: { status: 'gone' } }, bad);
    expect(bad.code).toBe(400);
  });
  it('409 when patching a posted draft', async () => {
    state.tables.social_post_drafts.push({ id: DRAFT, platform: 'linkedin', status: 'posted', body: 'x' });
    const r = res();
    await mount()['PATCH /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: DRAFT }, body: { body: 'new' } }, r);
    expect(r.code).toBe(409);
    expect(errCode(r)).toBe('locked');
    expect(state.calls).not.toContain('update social_post_drafts');
  });
  it('re-derives mentions when the body changes', async () => {
    state.tables.social_post_drafts.push({ id: DRAFT, platform: 'linkedin', status: 'draft', body: 'x', mentions: [] });
    state.tables.social_post_draft_sources.push({ draft_id: DRAFT, content_type: 'blog_post', content_id: ID1 });
    const r = res();
    await mount()['PATCH /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: DRAFT }, body: { body: 'Now with @Cisco', mentions: ['Evil'] } }, r);
    expect(r.code).toBe(200);
    expect(state.tables.social_post_drafts[0]).toMatchObject({ body: 'Now with @Cisco', mentions: ['Cisco'], updated_by: 'u1' });
  });
  it('400 for a non-uuid id', async () => {
    const r = res();
    await mount()['PATCH /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: 'nope' }, body: { status: 'ready' } }, r);
    expect(r.code).toBe(400);
  });
});

describe('admin gate on every route', () => {
  it('403s the draft write and read routes for a non-admin, with no writes', async () => {
    state.isAdmin = false;
    state.tables.social_post_drafts.push({ id: DRAFT, platform: 'linkedin', status: 'draft', body: 'x' });
    const h = mount();
    const cases: Array<[string, unknown]> = [
      ['POST /api/admin/social-posts/drafts', { headers: auth, body: { format: 'announcement', body: 'x', sources: [{ content_type: 'blog_post', content_id: ID1 }] } }],
      ['PATCH /api/admin/social-posts/drafts/:id', { headers: auth, params: { id: DRAFT }, body: { status: 'ready' } }],
      ['GET /api/admin/social-posts/drafts/:id', { headers: auth, params: { id: DRAFT } }],
    ];
    for (const [route, req] of cases) {
      const r = res();
      await h[route](req, r);
      expect(r.code).toBe(403);
    }
    expect(state.calls).toEqual([]);
  });
  it('401 for an expired token', async () => {
    state.adminError = Object.assign({ message: 'JWT expired' }, { code: 'PGRST303' });
    const r = res();
    await mount()['GET /api/admin/social-posts/pool']({ headers: auth, query: {} }, r);
    expect(r.code).toBe(401);
  });
});

describe('pool route', () => {
  it('validates types and clamps limit and search', async () => {
    const h = mount();
    const bad = res();
    await h['GET /api/admin/social-posts/pool']({ headers: auth, query: { types: 'bogus' } }, bad);
    expect(bad.code).toBe(400);
    const ok = res();
    await h['GET /api/admin/social-posts/pool']({ headers: auth, query: { types: 'blog_post,bogus', limit: '500' } }, ok);
    expect(ok.code).toBe(200);
    expect((ok.body as { available: string[] }).available).toEqual(['blog_post']);
    expect(state.lastLimit).toBe(100);
    await h['GET /api/admin/social-posts/pool']({ headers: auth, query: { limit: 'abc' } }, res());
    expect(state.lastLimit).toBe(40);
  });
});

describe('more refusals', () => {
  it('503 when the ai runner cannot load', async () => {
    state.runnerFails = true;
    const r = res();
    await mount()['POST /api/admin/social-posts/generate']({ headers: auth, body: { format: 'announcement', items: [{ content_type: 'blog_post', content_id: ID1 }] } }, r);
    expect(r.code).toBe(503);
    expect(errCode(r)).toBe('ai_unavailable');
  });
  it('404 when saving a draft from an unpublished item, with nothing inserted', async () => {
    state.tables.blog_posts[0].status = 'draft';
    const r = res();
    await mount()['POST /api/admin/social-posts/drafts']({ headers: auth, body: { format: 'announcement', body: 'x', sources: [{ content_type: 'blog_post', content_id: ID1 }] } }, r);
    expect(r.code).toBe(404);
    expect(state.calls).toEqual([]);
  });
  it('500, not a draft without mentions, when the member lookup fails on save', async () => {
    state.errorOn = 'content_keyword_item_state';
    const r = res();
    await mount()['POST /api/admin/social-posts/drafts']({ headers: auth, body: { format: 'announcement', body: 'x @Cisco', sources: [{ content_type: 'blog_post', content_id: ID1 }] } }, r);
    expect(r.code).toBe(500);
    expect(state.tables.social_post_drafts).toEqual([]);
  });
  it('409 when the draft is scheduled between lookup and update', async () => {
    state.tables.social_post_drafts.push({ id: DRAFT, platform: 'linkedin', status: 'draft', body: 'old' });
    state.flipOnUpdate = 'scheduled';
    const r = res();
    await mount()['PATCH /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: DRAFT }, body: { status: 'ready' } }, r);
    expect(r.code).toBe(409);
    expect(state.tables.social_post_drafts[0].body).toBe('old');
  });
  it('409 for an unsupported platform, 400 for an empty patch', async () => {
    state.tables.social_post_drafts.push({ id: DRAFT, platform: 'x', status: 'draft', body: 'x' });
    const h = mount();
    const r = res();
    await h['PATCH /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: DRAFT }, body: { status: 'ready' } }, r);
    expect(errCode(r)).toBe('unsupported');
    state.tables.social_post_drafts[0].platform = 'linkedin';
    const empty = res();
    await h['PATCH /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: DRAFT }, body: {} }, empty);
    expect(empty.code).toBe(400);
  });
  it('stamps generated_at and keeps the new direction after a regenerate', async () => {
    state.tables.social_post_drafts.push({ id: DRAFT, platform: 'linkedin', status: 'draft', body: 'x', instructions: 'old', generated_at: null });
    const r = res();
    await mount()['PATCH /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: DRAFT }, body: { body: 'new', regenerated: true, ai_model: 'claude-sonnet-5', instructions: 'shorter' } }, r);
    expect(r.code).toBe(200);
    expect(state.tables.social_post_drafts[0]).toMatchObject({ body: 'new', ai_model: 'claude-sonnet-5', instructions: 'shorter' });
    expect(typeof state.tables.social_post_drafts[0].generated_at).toBe('string');
  });
  it('GET one draft: 400, 404 and 200 with sources', async () => {
    state.tables.social_post_drafts.push({ id: DRAFT, platform: 'linkedin', status: 'draft', body: 'x' });
    state.tables.social_post_draft_sources.push({ draft_id: DRAFT, content_type: 'blog_post', content_id: ID1 });
    const h = mount();
    const bad = res();
    await h['GET /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: 'x' } }, bad);
    expect(bad.code).toBe(400);
    const none = res();
    await h['GET /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: ID1 } }, none);
    expect(none.code).toBe(404);
    const ok = res();
    await h['GET /api/admin/social-posts/drafts/:id']({ headers: auth, params: { id: DRAFT } }, ok);
    expect((ok.body as { draft: { sources: unknown[] } }).draft.sources).toHaveLength(1);
  });
});
