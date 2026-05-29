import { describe, it, expect } from 'vitest';
import { mountWikiRoutes } from '../api/wiki.js';

// Fake express Router capturing (method, path, handler).
function makeRouter() {
  const routes: Array<{ method: string; path: string; handler: (req: any, res: any) => Promise<void> }> = [];
  const add = (method: string) => (path: string, handler: any) => { routes.push({ method, path, handler }); };
  const r: any = { get: add('get'), post: add('post'), put: add('put'), delete: add('delete') };
  return { r, find: (method: string, path: string) => routes.find((x) => x.method === method && x.path === path)!.handler };
}

function makeRes() {
  const out: { status?: number; json?: any; sent?: boolean } = {};
  const res: any = {
    status(c: number) { out.status = c; return res; },
    json(j: any) { out.json = j; return res; },
    send() { out.sent = true; return res; },
  };
  return { res, out };
}

// Minimal chainable client; `single`/`list`/`write`/`rpc` configured per test.
function makeClient(script: any) {
  const calls: any[] = [];
  function builder(table: string): any {
    let write: string | null = null;
    const t = script.tables?.[table] ?? {};
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'maybeSingle') return () => Promise.resolve(write ? (t.write ?? { data: null, error: null }) : (t.single ?? { data: null, error: null }));
        if (prop === 'then') return (resolve: any) => Promise.resolve(write ? (t.write ?? { data: null, error: null }) : (t.list ?? { data: [], error: null })).then(resolve);
        if (prop === 'upsert' || prop === 'insert' || prop === 'update' || prop === 'delete') {
          return (...args: any[]) => { write = prop; calls.push({ table, op: prop, args }); return b; };
        }
        return () => b; // select/eq/in/is/like/order/limit/textSearch
      },
    });
    return b;
  }
  return { calls, from: (table: string) => builder(table), rpc: (fn: string, args: any) => { calls.push({ op: 'rpc', fn, args }); return Promise.resolve(script.rpc?.[fn] ?? { data: null, error: null }); } };
}

describe('wiki routes', () => {
  it('GET /admin/wiki/pages requires use_case', async () => {
    const { r, find } = makeRouter();
    mountWikiRoutes(r, { supabase: makeClient({}) as any });
    const { res, out } = makeRes();
    await find('get', '/admin/wiki/pages')({ query: {} }, res);
    expect(out.status).toBe(400);
    expect(out.json.error.code).toBe('invalid_input');
  });

  it('POST /admin/wiki/pages rejects missing fields', async () => {
    const { r, find } = makeRouter();
    mountWikiRoutes(r, { supabase: makeClient({}) as any });
    const { res, out } = makeRes();
    await find('post', '/admin/wiki/pages')({ body: { use_case: 'cfp' } }, res);
    expect(out.status).toBe(400);
  });

  it('POST /admin/wiki/pages 409 when slug already live', async () => {
    const { r, find } = makeRouter();
    const client = makeClient({ tables: { ai_wiki_page: { single: { data: { use_case: 'cfp', slug: 'a', title: 'X', body: '', deleted_at: null }, error: null } } } });
    mountWikiRoutes(r, { supabase: client as any });
    const { res, out } = makeRes();
    await find('post', '/admin/wiki/pages')({ body: { use_case: 'cfp', slug: 'a', title: 'T', body: 'B' } }, res);
    expect(out.status).toBe(409);
    expect(out.json.error.code).toBe('slug_exists');
  });

  it('PUT /admin/wiki/grants rejects a self-grant', async () => {
    const { r, find } = makeRouter();
    mountWikiRoutes(r, { supabase: makeClient({}) as any });
    const { res, out } = makeRes();
    await find('put', '/admin/wiki/grants')({ body: { grantee_use_case: 'cfp', grantor_use_case: 'cfp' } }, res);
    expect(out.status).toBe(400);
  });

  it('POST /admin/wiki/sync/run enqueues a push job', async () => {
    const { r, find } = makeRouter();
    const enq: any[] = [];
    mountWikiRoutes(r, { supabase: makeClient({}) as any, enqueueJob: async (q, n, d) => { enq.push({ q, n, d }); return { id: 'j1' }; } });
    const { res, out } = makeRes();
    await find('post', '/admin/wiki/sync/run')({ body: { use_case: 'cfp' } }, res);
    expect(out.status).toBe(202);
    expect(enq[0]).toMatchObject({ q: 'jobs', n: 'ai:wiki-push', d: { useCase: 'cfp' } });
  });

  it('POST /wiki/webhook/git 401 when no webhook secret configured', async () => {
    const { r, find } = makeRouter();
    mountWikiRoutes(r, { supabase: makeClient({ tables: { ai_wiki_sync_state: { single: { data: { webhook_secret: null }, error: null } } } }) as any });
    const { res, out } = makeRes();
    await find('post', '/wiki/webhook/git')({ query: { use_case: 'cfp' }, headers: {}, body: {} }, res);
    expect(out.status).toBe(401);
    expect(out.json.error.code).toBe('webhook_unverified');
  });
});
