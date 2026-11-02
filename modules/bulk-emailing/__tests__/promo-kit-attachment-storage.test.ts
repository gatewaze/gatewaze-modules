import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventCommsBinding } from '../workers/send-engine-binding-events';
import { setSharedStorageRegistry } from '../../storage/lib/bucket-store.js';
import { aliasedTestRegistry, supabaseTestRegistry } from '../../storage/lib/testing.js';

const ZIP = 'speaker-promo/e/t/speaker-kit.zip';

function deps() {
  const download = vi.fn(async () => ({ data: new Blob([Buffer.from('sb-zip')]), error: null }));
  const list = vi.fn(async () => ({ data: [{ name: 'speaker-kit.zip', metadata: { size: 6 } }] }));
  const kitQuery = { select: () => kitQuery, eq: () => kitQuery, maybeSingle: async () => ({ data: { zip_storage_path: ZIP, status: 'ready' } }) };
  return {
    download,
    list,
    deps: {
      supabase: { from: () => kitQuery, storage: { from: () => ({ download, list }) } },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    },
  };
}
const recipient = { context: { _meta: { talk_id: 't1' } } };

afterEach(() => {
  setSharedStorageRegistry(null);
  vi.unstubAllGlobals();
});

describe('promo-kit attachment storage', () => {
  it('downloads with supabase-js when the brand is on Supabase', async () => {
    setSharedStorageRegistry(supabaseTestRegistry());
    const d = deps();
    const out = await eventCommsBinding.buildAttachments!(d.deps as never, {} as never, recipient as never);
    expect(d.download).toHaveBeenCalledWith(ZIP);
    expect(Buffer.from(out![0]!.content, 'base64').toString()).toBe('sb-zip');
  });

  it('reads from the aliased store when the brand has moved', async () => {
    const t = aliasedTestRegistry({ objects: { [ZIP]: Buffer.from('r2-zip') } });
    setSharedStorageRegistry(t.registry);
    const fetchMock = vi.fn(async () => new Response('r2-zip', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const d = deps();
    const out = await eventCommsBinding.buildAttachments!(d.deps as never, {} as never, recipient as never);
    expect(d.download).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://s3.test/${ZIP}?sig`);
    expect(Buffer.from(out![0]!.content, 'base64').toString()).toBe('r2-zip');
  });
});
