/**
 * The avatar backfill worker (workers/mirror-avatars.ts).
 *
 * This is the only place in the importer that overwrites an existing
 * `avatar_url`, so the tests here are about what it refuses to touch and
 * about not reporting a row as copied when it wrote nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mirrorAvatarsForProfiles } from '../workers/mirror-avatars';
import { AVATAR_PREFIX } from '../lib/avatar-mirror';

const SCHED = 'https://avatars.sched.co/c/9d/19223528/avatar.jpg?73e';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.SUPABASE_PUBLIC_URL;
  process.env.SUPABASE_PUBLIC_URL = 'https://data.test.example';
});
afterEach(() => {
  if (saved === undefined) delete process.env.SUPABASE_PUBLIC_URL;
  else process.env.SUPABASE_PUBLIC_URL = saved;
});

interface Row { id: string; name: string; avatar_url: string | null }

/**
 * A supabase double covering only the shapes this worker uses.
 *
 * `updateMatches` decides what the conditional UPDATE returns, which is the
 * whole point: a CAS that matched nothing must not be counted as a copy.
 */
function db(rows: Row[], opts: { attached?: string[]; updateMatches?: boolean } = {}) {
  const updates: Array<{ id: string; avatar_url: string; expected: string }> = [];
  const uploads: string[] = [];
  const matches = opts.updateMatches !== false;

  /**
   * A thenable query builder, because the real chain is built in two steps:
   * `.select().like().limit()` and then conditionally `.in()`, with the await
   * only at the end. A `limit()` that returned a plain promise would break on
   * the `.in()` that follows it, which is how the first version of this
   * double failed.
   */
  function profileQuery() {
    const state: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    const settle = () => {
      if (!state.patch) return { data: rows, error: null };
      updates.push({
        id: String(state.id),
        avatar_url: String((state.patch as Record<string, string>).avatar_url),
        expected: String(state.avatar_url),
      });
      return { data: matches ? [{ id: state.id }] : [], error: null };
    };
    for (const m of ['select', 'like', 'in', 'limit', 'maybeSingle']) {
      q[m] = () => q;
    }
    q.update = (patch: Record<string, string>) => { state.patch = patch; return q; };
    q.eq = (col: string, val: string) => { state[col] = val; return q; };
    // Awaiting the builder at any point runs the query, which is how
    // postgrest-js behaves.
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(settle()).then(resolve, reject);
    return q;
  }

  return {
    updates,
    uploads,
    client: {
      from: (table: string) => {
        if (table === 'events_speakers') {
          return {
            select: () => ({
              eq: () => Promise.resolve({
                data: (opts.attached ?? rows.map((r) => r.id)).map((id) => ({ speaker_id: id })),
                error: null,
              }),
            }),
          };
        }
        return profileQuery();
      },
      storage: {
        from: () => ({
          list: async () => ({ data: [], error: null }),
          upload: async (path: string) => { uploads.push(path); return { error: null }; },
        }),
      },
    },
  };
}

const fetchOk = () => vi.fn(async () => ({
  ok: true, status: 200, bytes: JPEG, contentType: 'image/jpeg', finalUrl: SCHED,
}));

describe('mirrorAvatarsForProfiles', () => {
  it('copies a hot-linked avatar and rewrites the row', async () => {
    const d = db([{ id: 'p1', name: 'A', avatar_url: SCHED }]);
    const r = await mirrorAvatarsForProfiles(d.client as never, {
      eventUuid: 'e1',
      fetchBytes: fetchOk() as never,
    });
    expect(r).toMatchObject({ considered: 1, mirrored: 1, reused: 0, skipped: 0 });
    expect(r.bytes).toBe(JPEG.length);
    expect(d.uploads).toHaveLength(1);
    expect(d.updates).toHaveLength(1);
    expect(d.updates[0].avatar_url).toContain(AVATAR_PREFIX);
  });

  it('does not count a row as copied when the write matched nothing', async () => {
    // Someone edited the avatar between the read and the conditional write.
    // Before the UPDATE carried .select('id') this returned no error and the
    // run reported 1 copied having written nothing.
    const d = db([{ id: 'p1', name: 'A', avatar_url: SCHED }], { updateMatches: false });
    const r = await mirrorAvatarsForProfiles(d.client as never, {
      eventUuid: 'e1',
      fetchBytes: fetchOk() as never,
    });
    expect(r.mirrored).toBe(0);
    expect(r.reasons.changed_underneath).toBe(1);
    // The object did land in the bucket, so the bytes are still reported.
    expect(r.bytes).toBe(JPEG.length);
  });

  it('writes nothing on a dry run but still reports what it would do', async () => {
    const d = db([{ id: 'p1', name: 'A', avatar_url: SCHED }]);
    const r = await mirrorAvatarsForProfiles(d.client as never, {
      eventUuid: 'e1',
      dryRun: true,
      fetchBytes: fetchOk() as never,
    });
    expect(r.mirrored).toBe(1);
    expect(d.updates).toHaveLength(0);
  });

  it('refuses to fetch anything when the remote host is not allowlisted', async () => {
    const fetchBytes = fetchOk();
    const d = db([{ id: 'p1', name: 'A', avatar_url: 'https://tracker.example.com/p.gif' }]);
    await mirrorAvatarsForProfiles(d.client as never, { eventUuid: 'e1', fetchBytes: fetchBytes as never });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('never touches a bare storage path', async () => {
    // The candidate query filters on `avatar_url like 'http%'`, so a promo
    // path is not even read. The double returns it anyway, to prove the
    // in-loop guard also refuses it.
    const d = db([{ id: 'p1', name: 'A', avatar_url: 'avatars/promo-123.png' }]);
    const r = await mirrorAvatarsForProfiles(d.client as never, { eventUuid: 'e1' });
    expect(d.updates).toHaveLength(0);
    expect(r.reasons.host_not_allowlisted).toBe(1);
  });

  it('never touches a URL on a host outside the allowlist', async () => {
    const d = db([{ id: 'p1', name: 'A', avatar_url: 'https://tracker.example.com/p.gif' }]);
    const r = await mirrorAvatarsForProfiles(d.client as never, { eventUuid: 'e1' });
    expect(d.updates).toHaveLength(0);
    expect(r.reasons.host_not_allowlisted).toBe(1);
  });

  it('skips a URL that is already ours without a fetch', async () => {
    const ours = `https://data.test.example/storage/v1/object/public/media/${AVATAR_PREFIX}/abc.jpg`;
    const d = db([{ id: 'p1', name: 'A', avatar_url: ours }]);
    const r = await mirrorAvatarsForProfiles(d.client as never, { eventUuid: 'e1' });
    expect(r.reasons.already_ours).toBe(1);
    expect(d.updates).toHaveLength(0);
  });

  it('writes conditionally on the value it read', async () => {
    const d = db([{ id: 'p1', name: 'A', avatar_url: SCHED }]);
    await mirrorAvatarsForProfiles(d.client as never, { eventUuid: 'e1', fetchBytes: fetchOk() as never });
    expect(d.updates).toHaveLength(1);
    expect(d.updates[0].expected).toBe(SCHED);
    expect(d.updates[0].avatar_url).toContain(AVATAR_PREFIX);
  });

  it('reports nothing copied when nothing was attached to the event', async () => {
    const d = db([{ id: 'p1', name: 'A', avatar_url: SCHED }], { attached: [] });
    const r = await mirrorAvatarsForProfiles(d.client as never, { eventUuid: 'e1' });
    expect(r).toMatchObject({ considered: 0, mirrored: 0, reused: 0, skipped: 0 });
    expect(d.updates).toHaveLength(0);
  });

  it('clamps the limit rather than trusting it', async () => {
    const d = db([]);
    await expect(
      mirrorAvatarsForProfiles(d.client as never, { eventUuid: 'e1', limit: 1e9 }),
    ).resolves.toBeTruthy();
    await expect(
      mirrorAvatarsForProfiles(d.client as never, { eventUuid: 'e1', limit: -5 }),
    ).resolves.toBeTruthy();
  });
});
