/**
 * Where scraped content images go: Supabase Storage, or the aliased store
 * on a brand that has moved off it (storage module `supabase_alias`).
 *
 * The aliased case loads the TypeScript storage module, so run under tsx:
 *   npx tsx --test scripts/lib/__tests__/event-content-image-storage.test.js
 * Under plain node those cases are skipped.
 */

import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { deleteEventImages } from '../event-content-image-service.js';
import { movedBucketStore } from '../moved-store.js';

let storage = null;
before(async () => {
  try {
    storage = {
      ...(await import('../../../../storage/lib/bucket-store.js')),
      ...(await import('../../../../storage/lib/testing.js')),
    };
  } catch {
    storage = null;
  }
});
const skipUnlessTs = (t) => {
  if (!storage) t.skip('needs tsx to load the storage module');
  return !storage;
};

afterEach(() => storage?.setSharedStorageRegistry(null));

function supabaseDouble(files = []) {
  const calls = [];
  return {
    calls,
    client: {
      storage: {
        from: (bucket) => ({
          list: async (dir) => (calls.push(['list', bucket, dir]), { data: files, error: null }),
          remove: async (paths) => (calls.push(['remove', bucket, paths]), { error: null }),
        }),
      },
    },
  };
}

describe('content image storage', () => {
  test('a brand on Supabase keeps using supabase-js', async (t) => {
    if (skipUnlessTs(t)) return;
    storage.setSharedStorageRegistry(storage.supabaseTestRegistry());
    assert.equal(await movedBucketStore({}, 'event-content-images'), null);
    const s = supabaseDouble([{ name: 'a.png' }]);
    assert.deepEqual(await deleteEventImages(s.client, 'e1'), { success: true });
    assert.deepEqual(s.calls.at(-1), ['remove', 'event-content-images', ['e1/a.png']]);
  });

  test('a moved brand lists and removes in the aliased store', async (ctx) => {
    if (skipUnlessTs(ctx)) return;
    const t = storage.aliasedTestRegistry({
      objects: {
        'event-content-images/e1/a.png': Buffer.from('x'),
        'event-content-images/e1/sub/b.png': Buffer.from('y'),
        'event-content-images/e2/c.png': Buffer.from('z'),
      },
    });
    storage.setSharedStorageRegistry(t.registry);
    const s = supabaseDouble();
    assert.deepEqual(await deleteEventImages(s.client, 'e1'), { success: true });
    assert.equal(s.calls.length, 0);
    assert.deepEqual(t.calls.filter((c) => c.op === 'remove').map((c) => c.key), ['event-content-images/e1/a.png']);
  });
});
