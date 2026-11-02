import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadAndSign } from '../lib/storage';
import { setSharedStorageRegistry } from '../../storage/lib/bucket-store.js';
import { aliasedTestRegistry, supabaseTestRegistry } from '../../storage/lib/testing.js';

const input = {
  apiKeyId: 'k1',
  requestId: 'r1',
  bucket: 'fetch-screenshots',
  fileBytes: new Uint8Array([1, 2, 3]),
  mimeType: 'image/png',
  kind: 'screenshot' as const,
  ext: 'png',
  ttlSeconds: 600,
};

function supabaseDouble() {
  const upload = vi.fn(async () => ({ error: null }));
  const createSignedUrl = vi.fn(async (p: string) => ({ data: { signedUrl: `https://sb.test/sign/${p}?token=t` }, error: null }));
  return { upload, createSignedUrl, client: { storage: { from: () => ({ upload, createSignedUrl }) } } };
}

afterEach(() => setSharedStorageRegistry(null));

describe('uploadAndSign', () => {
  it('uses Supabase Storage on a brand still on it', async () => {
    setSharedStorageRegistry(supabaseTestRegistry());
    const s = supabaseDouble();
    const out = await uploadAndSign(s.client as never, input);
    expect(s.upload).toHaveBeenCalledOnce();
    expect(out.url).toMatch(/^https:\/\/sb\.test\/sign\//);
  });

  it('writes to the aliased store and hands out only a signed address', async () => {
    const t = aliasedTestRegistry();
    setSharedStorageRegistry(t.registry);
    const s = supabaseDouble();
    const out = await uploadAndSign(s.client as never, input);
    expect(s.upload).not.toHaveBeenCalled();
    const put = t.calls.find((c) => c.op === 'put')!;
    expect(put.key).toMatch(/^fetch-screenshots\/[0-9a-f]{12}\/r1\/screenshot\.png$/);
    expect(out.url).toBe(`https://s3.test/${put.key}?sig`);
    expect(new URL(out.url).host).not.toBe('media.test');
  });
});
