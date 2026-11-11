/**
 * The discovery worker: lease, auto-publish, narrow-only privacy, the cap.
 * The YouTube adapter, the OAuth client reader and the unsealer are stubbed;
 * the database is a recording fake that keeps the rows it is given.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeSupabase, type Chain } from './helpers/fake-supabase.js';

const listed: { videos: any[]; truncated: boolean; error?: string } = { videos: [], truncated: false };
const listCalls: Array<{ cap?: number }> = [];

vi.mock('../lib/adapter.js', async (orig) => {
  const real = await orig<typeof import('../lib/adapter.js')>();
  return {
    ...real,
    listChannelVideos: vi.fn(async (_c: unknown, _t: unknown, opts: { cap?: number }) => { listCalls.push(opts); return listed; }),
    fetchVideoDetails: vi.fn(async () => new Map()),
  };
});
vi.mock('../lib/client-credentials.js', () => ({ loadClientCredentials: async () => ({ clientId: 'c', clientSecret: 's' }) }));
vi.mock('../lib/secret-envelope.js', () => ({ unsealSecret: (v: string | null) => (v ? 'refresh' : null) }));

const { discoverAll, clampCap } = await import('../workers/discover-videos.js');

const START = '2026-11-11T03:40:00.000+00:00';
let lease: { data: unknown; error: unknown } = { data: START, error: null };
let finishResult: { data: unknown; error: unknown } = { data: true, error: null };
let publishError: { message: string } | null = null;
let existing: any[] = [];
let connConfig: Record<string, unknown> = {};
let sb = fakeSupabase(() => ({ data: null }));
let rpcCalls: Array<{ fn: string; args: unknown }> = [];

function client() {
  return {
    from: (t: string) => sb.client.from(t),
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === 'claim_video_discovery') return lease;
      if (fn === 'finish_video_discovery') return finishResult;
      if (fn === 'content_publish_state_set') return { data: null, error: publishError };
      return { data: null, error: null };
    },
  };
}

const upload = (id: string, privacy: string | null) => ({
  externalId: id, title: `T ${id}`, description: '', publishedAt: '2026-11-01T00:00:00Z', thumbnailUrl: null,
  durationSeconds: null, kind: 'master', privacy, raw: {},
});

beforeEach(() => {
  listed.videos = [];
  listed.truncated = false;
  listed.error = undefined;
  listCalls.length = 0;
  rpcCalls = [];
  lease = { data: START, error: null };
  finishResult = { data: true, error: null };
  publishError = null;
  existing = [];
  connConfig = {};
  sb = fakeSupabase((c: Chain) => {
    if (c.table === 'video_platform_connections' && c.calls.some((x) => x.op === 'select')) {
      return { data: [{ id: 'conn1', label: 'AAIF Live', external_account_id: 'UCx', encrypted_credentials: 'v1:x', config: connConfig }] };
    }
    if (c.table === 'videos' && c.calls.some((x) => x.op === 'insert')) return { data: { id: `new-${String((c.arg('insert') as any).provider_video_id)}` } };
    if (c.table === 'videos' && c.calls.some((x) => x.op === 'select')) return { data: existing };
    return { data: null };
  });
});

const inserts = () => sb.chains.filter((c) => c.table === 'videos' && c.calls.some((x) => x.op === 'insert')).map((c) => c.arg('insert') as any);
const updates = () => sb.chains.filter((c) => c.table === 'videos' && c.calls.some((x) => x.op === 'update')).map((c) => c.arg('update') as any);
const finish = () => rpcCalls.find((c) => c.fn === 'finish_video_discovery')?.args as any;
const published = () => rpcCalls.filter((c) => c.fn === 'content_publish_state_set').map((c) => (c.args as any).p_content_id);

describe('discoverAll', () => {
  it('passes the job cap and connection through, and clamps the cap', async () => {
    expect(clampCap(5000)).toBe(5000);
    expect(clampCap(10_000_000)).toBe(5000);
    expect(clampCap(undefined)).toBe(1000);
    expect(clampCap('nope')).toBe(1000);
    expect(clampCap(0)).toBe(1000);
    await discoverAll(client(), { connectionId: 'conn1', cap: 99999 });
    expect(listCalls[0].cap).toBe(5000);
    const sel = sb.chains.find((c) => c.table === 'video_platform_connections')!;
    expect(sel.has('eq', 'id', 'conn1')).toBe(true);
    expect(sel.has('eq', 'state', 'connected')).toBe(true);
  });

  it('takes the lease, and skips the channel when another run holds it', async () => {
    listed.videos = [upload('AAAAAAAAAAA', 'public')];
    await discoverAll(client());
    expect(rpcCalls[0]).toEqual({ fn: 'claim_video_discovery', args: { p_connection: 'conn1' } });
    expect(finish()).toMatchObject({ p_connection: 'conn1', p_started_at: START });

    lease = { data: null, error: null };
    sb.chains.length = 0;
    rpcCalls = [];
    const r = await discoverAll(client());
    expect(listCalls).toHaveLength(1);
    expect(inserts()).toHaveLength(0);
    // A skipped run says so, and never releases the running run's lease.
    expect(r.errors.some((e) => e.includes('in progress'))).toBe(true);
    expect(finish()).toBeUndefined();
  });

  it('runs without a lease against an older videos module, and stops on any other lease error', async () => {
    listed.videos = [upload('AAAAAAAAAAA', 'public')];
    lease = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.claim_video_discovery' } };
    await discoverAll(client());
    expect(inserts()).toHaveLength(1);
    expect(finish()).toBeUndefined();

    lease = { data: null, error: { code: '57014', message: 'timeout' } };
    const r = await discoverAll(client());
    expect(r.errors.some((e) => e.includes('lease'))).toBe(true);
  });

  it('releases the lease even when the run throws, and on early returns', async () => {
    const adapter = await import('../lib/adapter.js');
    vi.mocked(adapter.listChannelVideos).mockImplementationOnce(async () => { throw new Error('kaboom'); });
    const r = await discoverAll(client());
    expect(r.errors.some((e) => e.includes('kaboom'))).toBe(true);
    expect(finish()).toMatchObject({ p_started_at: START });

    rpcCalls = [];
    listed.videos = [];
    listed.error = 'auth';
    await discoverAll(client());
    expect(String(finish().p_detail)).toContain('reconnect');
    listed.error = undefined;
  });

  it('reports a release it could not record', async () => {
    finishResult = { data: false, error: null };
    listed.videos = [upload('AAAAAAAAAAA', 'public')];
    const r = await discoverAll(client());
    expect(r.errors.some((e) => e.includes('could not record'))).toBe(true);
  });

  it('inserts drafts, and private or unlisted uploads as private, when auto-publish is off', async () => {
    listed.videos = [upload('AAAAAAAAAAA', 'public'), upload('BBBBBBBBBBB', 'unlisted'), upload('CCCCCCCCCCC', null)];
    await discoverAll(client());
    expect(inserts().map((i) => [i.visibility, i.status, i.publish_state])).toEqual([
      ['public', 'draft', 'draft'],
      ['private', 'draft', 'draft'],
      ['private', 'draft', 'draft'],
    ]);
    expect(published()).toEqual([]);
  });

  it('publishes public uploads on insert when the channel auto-publishes, and only those', async () => {
    connConfig = { auto_publish: true };
    listed.videos = [upload('AAAAAAAAAAA', 'public'), upload('BBBBBBBBBBB', 'private')];
    const r = await discoverAll(client());
    // Inserted as drafts, then published through the state machine (audited).
    expect(inserts().map((i) => [i.visibility, i.status])).toEqual([['public', 'draft'], ['private', 'draft']]);
    expect(published()).toEqual(['new-AAAAAAAAAAA']);
    expect(rpcCalls.find((c) => c.fn === 'content_publish_state_set')!.args).toMatchObject({ p_to: 'published', p_actor: 'system:youtube-auto-publish' });
    expect(r.published).toBe(1);
    expect(String(finish().p_detail)).toContain('1 published');
  });

  it('on an existing row: visibility mirrors YouTube both ways; unknown leaves it', async () => {
    listed.videos = [upload('AAAAAAAAAAA', 'unlisted'), upload('BBBBBBBBBBB', 'public'), upload('CCCCCCCCCCC', null), upload('DDDDDDDDDDD', 'public')];
    existing = [
      { id: 'a', provider_video_id: 'AAAAAAAAAAA', title: 'x', status: 'published', visibility: 'public' },
      { id: 'b', provider_video_id: 'BBBBBBBBBBB', title: 'x', status: 'draft', visibility: 'private' },
      { id: 'c', provider_video_id: 'CCCCCCCCCCC', title: 'x', status: 'draft', visibility: 'public' },
      { id: 'd', provider_video_id: 'DDDDDDDDDDD', title: 'x', status: 'draft', visibility: 'public' },
    ];
    await discoverAll(client());
    const [a, b, c, d] = updates();
    expect(a.visibility).toBe('private');
    expect(b.visibility).toBe('public');
    expect(c).not.toHaveProperty('visibility');
    expect(d).not.toHaveProperty('visibility');
    // auto-publish is off: nothing is published.
    expect(published()).toEqual([]);
  });

  it('auto-publishes only undecided drafts that YouTube says are public', async () => {
    connConfig = { auto_publish: true };
    listed.videos = [upload('AAAAAAAAAAA', 'public'), upload('BBBBBBBBBBB', 'public'), upload('CCCCCCCCCCC', 'unlisted'), upload('DDDDDDDDDDD', 'public')];
    existing = [
      { id: 'a', provider_video_id: 'AAAAAAAAAAA', title: 'x', status: 'draft', visibility: 'private' },
      { id: 'b', provider_video_id: 'BBBBBBBBBBB', title: 'x', status: 'archived', visibility: 'public' },
      { id: 'c', provider_video_id: 'CCCCCCCCCCC', title: 'x', status: 'draft', visibility: 'public' },
      { id: 'd', provider_video_id: 'DDDDDDDDDDD', title: 'x', status: 'rejected', visibility: 'public' },
    ];
    await discoverAll(client());
    // a: went public on YouTube and was a draft; b: unpublished by hand;
    // c: unlisted now; d: rejected in triage.
    expect(published()).toEqual(['a']);
  });

  it('reports a publish the state machine refuses, without stopping', async () => {
    connConfig = { auto_publish: true };
    publishError = { message: 'INVALID_STATE_TRANSITION' };
    listed.videos = [upload('AAAAAAAAAAA', 'public'), upload('BBBBBBBBBBB', 'public')];
    const r = await discoverAll(client());
    expect(inserts()).toHaveLength(2);
    expect(r.published).toBe(0);
    expect(r.errors.filter((e) => e.includes('publish'))).toHaveLength(2);
  });

  it('says a listing that failed partway failed, rather than that it hit the limit', async () => {
    listed.videos = [upload('AAAAAAAAAAA', 'public')];
    listed.truncated = true;
    listed.error = 'playlistItems returned 403';
    await discoverAll(client(), { cap: 5000 });
    expect(String(finish().p_detail)).toContain('Listing stopped early');
    expect(String(finish().p_detail)).not.toContain('limit');
    listed.error = undefined;
  });

  it('records a run that hit the limit', async () => {
    listed.videos = [upload('AAAAAAAAAAA', 'public')];
    listed.truncated = true;
    const r = await discoverAll(client(), { cap: 5000 });
    expect(r.truncated).toBe(true);
    expect(String(finish().p_detail)).toContain('5,000-upload limit');
  });
});
