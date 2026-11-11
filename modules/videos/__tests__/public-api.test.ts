/**
 * /api/v1/videos on a real Express router with a stand-in PublicApiContext.
 * The gating lives in the videos_api_public view (migration 021), so these
 * pin that every read goes through it, plus the filters, validation, scope
 * and envelope.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { registerPublicApi, safeSearch, VIDEO_FIELDS } from '../public-api.js';
import { fakeSupabase, type Chain, type Responder } from './helpers/fake-supabase.js';

let respond: Responder = () => ({ data: [] });
let scopes = ['videos:read'];
let sb = fakeSupabase((c) => respond(c));
let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(() => {
  const ctx = {
    get supabase() { return sb.client; },
    logger: { warn: () => {} },
    requireScope: (action: string) => (_req: any, res: any, next: any) =>
      scopes.includes(`videos:${action}`) ? next() : res.status(403).json({ error: { code: 'INSUFFICIENT_SCOPE', message: 'no' } }),
    parsePagination: (q: { limit?: string; offset?: string }) => {
      const limit = q.limit === undefined ? 25 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'limit' };
      return { limit, offset: q.offset === undefined ? 0 : Number(q.offset) };
    },
    parseFields: (raw: string | undefined, allowed: string[]) => {
      if (raw === undefined) return allowed;
      const f = raw.split(',').filter((x) => allowed.includes(x));
      return f.length ? f : allowed;
    },
    setCache: (res: any) => res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600'),
  };
  const router = express.Router();
  // ctx.supabase is read once at registration, so route through a getter-backed proxy.
  registerPublicApi(router, new Proxy(ctx, { get: (t, p) => (p === 'supabase' ? { from: (x: string) => sb.client.from(x) } : (t as any)[p]) }));
  const app = express();
  app.use('/api/v1/videos', router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/videos`;
});
afterAll(() => server.close());

function use(r: Responder, s = ['videos:read']) {
  respond = r;
  scopes = s;
  sb = fakeSupabase((c) => respond(c));
}
const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const listChain = () => sb.chains.find((c) => c.table === 'videos_api_public')!;

describe('GET /api/v1/videos', () => {
  it.each(['', '/AAAAAAAAAAA', '/9f16b535-a9e4-4045-a01a-f9c233d716bd'])('%s needs videos:read', async (p) => {
    use(() => ({ data: [] }), ['podcasts:read']);
    expect((await get(p)).status).toBe(403);
    expect(sb.chains).toHaveLength(0);
  });

  it('reads only the gated view, newest first, with the standard envelope', async () => {
    use(() => ({ data: [{ id: 'v1' }], count: 1 }));
    const r = await get('');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [{ id: 'v1' }], pagination: { total: 1, limit: 25, offset: 0, has_more: false }, _links: { self: '/api/v1/videos' } });
    expect(sb.chains.map((c) => c.table)).toEqual(['videos_api_public']);
    expect(listChain().has('order', 'published_at', { ascending: false, nullsFirst: false })).toBe(true);
    expect(r.headers.get('cache-control')).toContain('public');
  });

  it('applies channel, kind, date, topic and search filters', async () => {
    use(() => ({ data: [], count: 0 }));
    const r = await get('?channel=UCG6qpjVnBTTT8wLGBygANOQ&kind=full&from=2026-01-01&to=2026-11-01T00:00:00Z&topics=mcp,agents&q=mcp,id.gt.0)');
    expect(r.status).toBe(200);
    const c = listChain();
    expect(c.has('eq', 'channel_id', 'UCG6qpjVnBTTT8wLGBygANOQ')).toBe(true);
    expect(c.has('eq', 'kind', 'full')).toBe(true);
    expect(c.has('gte', 'published_at', '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(c.has('lte', 'published_at', '2026-11-01T00:00:00.000Z')).toBe(true);
    expect(c.has('overlaps', 'topics', ['mcp', 'agents'])).toBe(true);
    expect(String(c.arg('or'))).toBe('title.ilike.%mcpid.gt.0%,description.ilike.%mcpid.gt.0%');
  });

  it('filters by event through video_subjects, and answers an empty page when nothing is linked', async () => {
    const EV = 'e0000000-0000-0000-0000-000000000001';
    use((c: Chain) => (c.table === 'video_subjects' ? { data: [{ video_id: 'v1' }, { video_id: 'v1' }, { video_id: 'v2' }] } : { data: [{ id: 'v1' }], count: 1 }));
    await get(`?event=${EV}`);
    const subj = sb.chains.find((c) => c.table === 'video_subjects')!;
    expect(subj.has('eq', 'subject_type', 'event')).toBe(true);
    expect(subj.has('eq', 'subject_id', EV)).toBe(true);
    expect(subj.arg('limit')).toBe(200);
    expect(listChain().has('in', 'id', ['v1', 'v2'])).toBe(true);

    use((c: Chain) => (c.table === 'video_subjects' ? { data: [] } : { data: [{ id: 'leak' }], count: 1 }));
    const r = await get(`?podcast_episode=${EV}`);
    expect(r.body.data).toEqual([]);
    expect(sb.chains.some((c) => c.table === 'videos_api_public')).toBe(false);
  });

  it.each([
    '?channel=not-a-channel',
    '?kind=private',
    '?event=nope',
    '?podcast_episode=1',
    '?event=e0000000-0000-0000-0000-000000000001&podcast_episode=e0000000-0000-0000-0000-000000000001',
    '?from=yesterday',
    '?topics=ok,(bad)',
    '?limit=500',
  ])('rejects %s with 400', async (q) => {
    use(() => ({ data: [] }));
    const r = await get(q);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not leak database errors', async () => {
    use(() => ({ error: { message: 'relation "secret_table" does not exist' } }));
    const r = await get('');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret_table');
  });

  it('sanitises search text', () => {
    expect(safeSearch('a(b)*c\\d%e:f')).toBe('abcdef');
  });
});

describe('GET /api/v1/videos/:id', () => {
  it('looks up a YouTube id, and returns public links without people', async () => {
    use((c: Chain) => (c.table === 'video_subjects'
      ? { data: [{ subject_type: 'event', subject_id: 'e1' }, { subject_type: 'podcast_episode', subject_id: 'p1' }] }
      : { data: { id: 'v1', title: 'T' } }));
    const r = await get('/FKjj1OGALkc');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: 'v1', subjects: [{ type: 'event', id: 'e1' }, { type: 'podcast_episode', id: 'p1' }] });
    const v = listChain();
    expect(v.has('eq', 'provider', 'youtube')).toBe(true);
    expect(v.has('eq', 'provider_video_id', 'FKjj1OGALkc')).toBe(true);
    const subj = sb.chains.find((c) => c.table === 'video_subjects')!;
    expect(subj.arg('in', 1)).toEqual(['event', 'podcast_episode', 'talk', 'agenda_entry']);
  });

  it('looks up a uuid by id', async () => {
    use((c: Chain) => (c.table === 'video_subjects' ? { data: [] } : { data: { id: 'x' } }));
    const id = '9f16b535-a9e4-4045-a01a-f9c233d716bd';
    expect((await get(`/${id}`)).status).toBe(200);
    expect(listChain().has('eq', 'id', id)).toBe(true);
  });

  it('answers 404 for an id that is neither, without querying, and for a video the view hides', async () => {
    use(() => ({ data: null }));
    expect((await get('/a.b,c')).status).toBe(404);
    expect(sb.chains).toHaveLength(0);
    expect((await get('/AAAAAAAAAAA')).status).toBe(404);
  });

  it('answers database failures as 500', async () => {
    use(() => ({ error: { message: 'boom' } }));
    expect((await get('/AAAAAAAAAAA')).status).toBe(500);
  });
});

describe('manifest', () => {
  it('serves the same fields in /api/v1/content as the list route, from the gated view', async () => {
    const manifest = (await import('../index.js')).default as { publicContentSources: Array<{ table: string; fullFields: string[]; scope: string }> };
    expect(manifest.publicContentSources[0]).toMatchObject({ table: 'videos_api_public', scope: 'videos:read' });
    expect(manifest.publicContentSources[0].fullFields).toEqual([...VIDEO_FIELDS]);
  });
});
