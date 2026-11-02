// @ts-nocheck — vitest harness.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { movedBucketStore } from '../moved-store.js';
import { cleanupExpiredChunkedUploads } from '../../workers/chunked-cleanup-cron.js';
import { createChunkedRoutes } from '../../api/chunked-routes.js';
import { registerHostMediaConsumer } from '../registry.js';
import { setSharedStorageRegistry } from '../../../storage/lib/bucket-store.js';
import { aliasedTestRegistry, supabaseTestRegistry } from '../../../storage/lib/testing.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => setSharedStorageRegistry(null));

function cronSupabase() {
  const remove = vi.fn(async () => ({ error: null }));
  const q = {
    select: () => q,
    in: () => q,
    lt: async () => ({ data: [{ id: 's1', host_kind: 'event', host_id: 'h1', total_chunks: 2 }], error: null }),
    update: () => ({ eq: async () => ({ error: null }) }),
  };
  return { remove, client: { from: () => q, storage: { from: () => ({ remove }) } } };
}

describe('movedBucketStore', () => {
  it('is null on a brand still on Supabase', async () => {
    setSharedStorageRegistry(supabaseTestRegistry());
    expect(await movedBucketStore({}, 'media')).toBeNull();
  });
  it('is the aliased store when the brand has moved', async () => {
    setSharedStorageRegistry(aliasedTestRegistry().registry);
    expect((await movedBucketStore({}, 'media'))?.publicUrl('a.jpg')).toBe('https://media.test/a.jpg');
  });
});

describe('chunked cleanup', () => {
  it('removes chunks with supabase-js on a Supabase brand', async () => {
    setSharedStorageRegistry(supabaseTestRegistry());
    const s = cronSupabase();
    await cleanupExpiredChunkedUploads({ supabase: s.client, logger });
    expect(s.remove).toHaveBeenCalledWith(['event/h1/__chunked/s1/0', 'event/h1/__chunked/s1/1']);
  });
  it('removes chunks from the aliased store when the brand has moved', async () => {
    const t = aliasedTestRegistry();
    setSharedStorageRegistry(t.registry);
    const s = cronSupabase();
    await cleanupExpiredChunkedUploads({ supabase: s.client, logger });
    expect(s.remove).not.toHaveBeenCalled();
    expect(t.calls.filter((c) => c.op === 'remove').map((c) => c.key)).toEqual(['event/h1/__chunked/s1/0', 'event/h1/__chunked/s1/1']);
  });
});

describe('chunked init', () => {
  it('is refused when the brand has moved off Supabase Storage', async () => {
    registerHostMediaConsumer({ hostKind: 'event' });
    setSharedStorageRegistry(aliasedTestRegistry().registry);
    const insert = vi.fn();
    const routes = createChunkedRoutes({ supabase: { from: () => ({ insert }) }, storageBucket: 'media', logger });
    const res = { status: vi.fn(() => res), json: vi.fn() };
    await routes.init({
      params: { hostKind: 'event', hostId: '11111111-1111-4111-8111-111111111111' },
      userId: 'u1',
      body: { filename: 'a.mp4', mime_type: 'video/mp4', total_bytes: 10, total_chunks: 1 },
    }, res);
    expect(res.status).toHaveBeenCalledWith(501);
    expect(insert).not.toHaveBeenCalled();
  });
});
