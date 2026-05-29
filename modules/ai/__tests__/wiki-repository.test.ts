import { describe, it, expect } from 'vitest';
import {
  buildUpsertRow,
  linkRowsFor,
  parseWhereFilter,
  upsertPage,
  type WikiDbClient,
} from '../lib/wiki/repository.js';

// --- compact chainable PostgREST mock --------------------------------------
interface Script {
  rpc?: Record<string, { data: unknown; error: { message: string } | null }>;
  tables?: Record<string, { single?: { data: unknown; error: { message: string } | null }; list?: { data: unknown; error: { message: string } | null }; write?: { data: unknown; error: { message: string } | null } }>;
}
interface Call { table?: string; op: string; row?: unknown; rows?: unknown; fn?: string; args?: unknown }

function makeClient(script: Script): WikiDbClient & { calls: Call[] } {
  const calls: Call[] = [];
  function builder(table: string): any {
    let write: string | null = null;
    const t = script.tables?.[table] ?? {};
    const b: any = {
      select: () => b, eq: () => b, in: () => b, is: () => b, like: () => b,
      order: () => b, limit: () => b, textSearch: () => b,
      upsert: (row: unknown) => { write = 'upsert'; calls.push({ table, op: 'upsert', row }); return b; },
      insert: (rows: unknown) => { write = 'insert'; calls.push({ table, op: 'insert', rows }); return b; },
      update: (row: unknown) => { write = 'update'; calls.push({ table, op: 'update', row }); return b; },
      delete: () => { write = 'delete'; calls.push({ table, op: 'delete' }); return b; },
      maybeSingle: () => Promise.resolve(write ? (t.write ?? { data: null, error: null }) : (t.single ?? { data: null, error: null })),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(write ? (t.write ?? { data: null, error: null }) : (t.list ?? { data: [], error: null })).then(resolve),
    };
    return b;
  }
  return {
    calls,
    from: (table: string) => builder(table),
    rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ op: 'rpc', fn, args }); return Promise.resolve(script.rpc?.[fn] ?? { data: null, error: null }); },
  };
}

describe('pure helpers', () => {
  it('buildUpsertRow sets content_hash, change_seq, defaults', () => {
    const row = buildUpsertRow({ useCase: 'cfp', slug: 'a/b', title: 'T', body: 'B' }, 7);
    expect(row.change_seq).toBe(7);
    expect(row.source).toBe('model');
    expect(row.metadata).toEqual({});
    expect(row.deleted_at).toBeNull();
    expect(String(row.content_hash)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('linkRowsFor maps link refs to rows', () => {
    expect(linkRowsFor('cfp', 'a', [{ to_use_case: 'cfp', to_slug: 'b' }])).toEqual([
      { from_use_case: 'cfp', from_slug: 'a', to_use_case: 'cfp', to_slug: 'b' },
    ]);
  });
  it('parseWhereFilter keeps scalar keys, drops bad keys/values', () => {
    expect(parseWhereFilter({ disposition: 'keep', n: 3, ok: true, 'bad-key': 'x', obj: {} })).toEqual({ disposition: 'keep', n: 3, ok: true });
  });
});

describe('upsertPage', () => {
  it('rejects an invalid slug without touching the DB', async () => {
    const client = makeClient({});
    const res = await upsertPage(client, { useCase: 'cfp', slug: 'Bad Slug', title: 'T', body: 'B' }, null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid_slug/);
    expect(client.calls).toHaveLength(0);
  });

  it('allocates a seq, upserts the page, rebuilds links, and embeds when an embedder is given', async () => {
    const client = makeClient({
      rpc: { ai_wiki_alloc_seq: { data: 7, error: null } },
      tables: {
        ai_wiki_page: { single: { data: null, error: null }, write: { data: { id: 'p1', version: 1 }, error: null } },
        ai_wiki_link: {},
      },
    });
    const res = await upsertPage(
      client,
      { useCase: 'cfp', slug: 'conferences/mumbai/x', title: 'T', body: 'see [[meta/topics/gateways]]' },
      async () => [[0.1, 0.2, 0.3]],
    );
    expect(res.ok).toBe(true);
    expect(res.version).toBe(1);
    expect(res.warning).toBeUndefined(); // embedded synchronously

    expect(client.calls.some((c) => c.op === 'rpc' && c.fn === 'ai_wiki_alloc_seq')).toBe(true);
    const pageUpsert = client.calls.find((c) => c.table === 'ai_wiki_page' && c.op === 'upsert');
    expect(pageUpsert).toBeTruthy();
    expect((pageUpsert!.row as Record<string, unknown>).change_seq).toBe(7);
    expect((pageUpsert!.row as Record<string, unknown>).version).toBe(1);
    expect(client.calls.some((c) => c.table === 'ai_wiki_link' && c.op === 'delete')).toBe(true);
    const linkInsert = client.calls.find((c) => c.table === 'ai_wiki_link' && c.op === 'insert');
    expect((linkInsert!.rows as Array<Record<string, string>>)[0]).toMatchObject({ to_use_case: 'cfp', to_slug: 'meta/topics/gateways' });
    expect(client.calls.some((c) => c.table === 'ai_wiki_page' && c.op === 'update')).toBe(true); // embedding write
  });

  it('defers embedding when no embedder is provided', async () => {
    const client = makeClient({
      rpc: { ai_wiki_alloc_seq: { data: 1, error: null } },
      tables: { ai_wiki_page: { single: { data: null, error: null }, write: { data: { id: 'p', version: 1 }, error: null } }, ai_wiki_link: {} },
    });
    const res = await upsertPage(client, { useCase: 'cfp', slug: 'a', title: 'T', body: 'no links' }, null);
    expect(res.ok).toBe(true);
    expect(res.warning).toBe('embed_deferred');
    expect(client.calls.some((c) => c.table === 'ai_wiki_link' && c.op === 'insert')).toBe(false); // no links to insert
  });
});
