import { describe, expect, it } from 'vitest';
import { registerPublicApi } from '../public-api';

type Result = { data: unknown; error: unknown; count?: number };

// A PostgREST-ish builder that records calls and resolves per table.
function fakeSupabase(results: Record<string, Result>) {
  const calls: Array<[string, ...unknown[]]> = [];
  const client = {
    from(table: string) {
      calls.push(['from', table]);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'or', 'order', 'range', 'ilike', 'maybeSingle']) {
        builder[m] = (...args: unknown[]) => { calls.push([m, ...args]); return builder; };
      }
      builder.then = (resolve: (v: unknown) => void) => resolve(results[table] ?? { data: [], error: null });
      return builder;
    },
  };
  return { client, calls };
}

function mount(results: Record<string, Result>) {
  const routes = new Map<string, (req: unknown, res: unknown) => Promise<unknown>>();
  const router = { get: (path: string, ...handlers: any[]) => routes.set(path, handlers[handlers.length - 1]) };
  const { client, calls } = fakeSupabase(results);
  registerPublicApi(router, {
    supabase: client,
    requireScope: () => () => {},
    parsePagination: () => ({ limit: 50, offset: 0 }),
    setCache: () => {},
  });
  return { routes, calls };
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (s: number) => { res.statusCode = s; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

const storedRow = {
  id: '6f1c2c58-7d6e-4f53-9d55-0d7a2a1b9b10',
  calendar_id: 'CAL-AAIFLONDON',
  name: 'AAIF London',
  slug: 'aaif-london',
  location: { type: 'city', city: 'London', country_code: 'GB', source: 'luma', internal: 'x' },
};

describe('GET /:id', () => {
  it('returns 404 without querying for a key that could change the .or() filter', async () => {
    const { routes, calls } = mount({});
    for (const key of ['aaif,id.neq.0', 'aaif.london', 'x)', 'a b']) {
      const res = fakeRes();
      await routes.get('/:id')!({ params: { id: key } }, res);
      expect(res.statusCode).toBe(404);
    }
    expect(calls.find((c) => c[0] === 'or')).toBeUndefined();
  });

  it('looks up a slug or calendar_id, and a UUID by id', async () => {
    const { routes, calls } = mount({ calendars: { data: storedRow, error: null } });
    await routes.get('/:id')!({ params: { id: 'aaif-london' } }, fakeRes());
    await routes.get('/:id')!({ params: { id: storedRow.id } }, fakeRes());
    const ors = calls.filter((c) => c[0] === 'or').map((c) => c[1]);
    expect(ors).toEqual(['calendar_id.eq.aaif-london,slug.eq.aaif-london', `id.eq.${storedRow.id}`]);
  });

  it('selects only the location key of settings and serves the public shape', async () => {
    const { routes, calls } = mount({ calendars: { data: storedRow, error: null } });
    const res = fakeRes();
    await routes.get('/:id')!({ params: { id: 'aaif-london' } }, res);
    const select = String(calls.find((c) => c[0] === 'select')?.[1]);
    expect(select).toContain('location:settings->location');
    expect(select.split(',')).not.toContain('settings');
    expect(res.body.data.location).toEqual({
      type: 'city', city: 'London', region: null, country: null, country_code: 'GB',
      continent: null, latitude: null, longitude: null, source: 'luma',
    });
  });
});

describe('GET /', () => {
  it('maps each row through the public location shape', async () => {
    const { routes } = mount({ calendars: { data: [storedRow, { ...storedRow, id: 'b', location: { type: 'global' } }], error: null, count: 2 } });
    const res = fakeRes();
    await routes.get('/')!({ query: {}, originalUrl: '/api/v1/calendars' }, res);
    expect(res.body.data[0].location).not.toHaveProperty('internal');
    expect(res.body.data[0].location.city).toBe('London');
    expect(res.body.data[1].location).toBeNull();
  });
});
