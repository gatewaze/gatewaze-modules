import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
let respond: (name: string, input: Record<string, unknown>) => unknown = () => ({});

vi.mock('@aws-sdk/client-s3', () => {
  const cmd = (name: string) => class {
    name = name;
    constructor(public input: Record<string, unknown>) {}
  };
  return {
    S3Client: class {
      constructor(public config: Record<string, unknown>) {}
      async send(c: { name: string; input: Record<string, unknown> }) {
        sent.push({ name: c.name, input: c.input });
        const r = respond(c.name, c.input);
        if (r instanceof Error) throw r;
        return r;
      }
    },
    PutObjectCommand: cmd('PutObject'),
    GetObjectCommand: cmd('GetObject'),
    HeadObjectCommand: cmd('HeadObject'),
    DeleteObjectsCommand: cmd('DeleteObjects'),
    ListObjectsV2Command: cmd('ListObjectsV2'),
    CopyObjectCommand: cmd('CopyObject'),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, c: { name: string; input: Record<string, unknown> }, o: { expiresIn: number }) =>
    `https://signed.example/${c.name}/${String(c.input.Key)}?type=${String(c.input.ContentType ?? '')}&len=${String(c.input.ContentLength ?? '')}&exp=${o.expiresIn}`),
}));

const { s3Store, cloudflareImageOptions, resetS3ClientsForTests } = await import('../s3-store.js');

const SETTINGS = {
  provider: 'r2',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  region: 'auto',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  publicBaseUrl: 'https://media.example.com/',
  resize: 'cloudflare' as const,
};

beforeEach(() => {
  sent.length = 0;
  respond = () => ({});
  resetS3ClientsForTests();
});

describe('s3 store addresses', () => {
  it('serves files from the public domain with each segment encoded', () => {
    const store = s3Store(SETTINGS, 'media');
    expect(store.publicUrl('event/e 1/photo.jpg')).toBe('https://media.example.com/event/e%201/photo.jpg');
    expect(store.publicUrl('a/b.jpg', { version: 'x' })).toBe('https://media.example.com/a/b.jpg?v=x');
  });

  it('resizes through Cloudflare on the same domain', () => {
    const store = s3Store(SETTINGS, 'media');
    expect(store.canResize).toBe(true);
    expect(store.sizedUrl('a/b.jpg', { width: 640, quality: 75 })).toBe(
      'https://media.example.com/cdn-cgi/image/width=640,fit=scale-down,quality=75,format=auto/a/b.jpg',
    );
    expect(store.sizedUrl('a/b.jpg', { width: 300, height: 300, fit: 'cover' }, { version: 2 })).toBe(
      'https://media.example.com/cdn-cgi/image/width=300,height=300,fit=cover,quality=80,format=auto/a/b.jpg?v=2',
    );
  });

  it('clamps sizes so a caller cannot ask for anything huge', () => {
    expect(cloudflareImageOptions({ width: 99999, quality: 500 })).toBe('width=4096,fit=scale-down,quality=100,format=auto');
  });

  it('returns the original when resizing is off', () => {
    const store = s3Store({ ...SETTINGS, resize: 'none' }, 'media');
    expect(store.canResize).toBe(false);
    expect(store.sizedUrl('a/b.jpg', { width: 640 })).toBe('https://media.example.com/a/b.jpg');
  });
});

describe('s3 store operations', () => {
  it('signs uploads with the type and size pinned', async () => {
    const store = s3Store(SETTINGS, 'media');
    const up = await store.signUpload('a/b.jpg', { contentType: 'image/jpeg', bytes: 1234, expiresSeconds: 600 });
    expect(up).toEqual({
      url: 'https://signed.example/PutObject/a/b.jpg?type=image/jpeg&len=1234&exp=600',
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
    });
  });

  it('will not overwrite an existing object unless asked', async () => {
    respond = (name) => (name === 'HeadObject' ? { ContentLength: 3, ContentType: 'image/jpeg' } : {});
    const store = s3Store(SETTINGS, 'media');
    await expect(store.put('a/b.jpg', Buffer.from('abc'), { contentType: 'image/jpeg' })).rejects.toThrow('already exists');
    expect(sent.some((s) => s.name === 'PutObject')).toBe(false);
    await store.put('a/b.jpg', Buffer.from('abc'), { contentType: 'image/jpeg', upsert: true });
    const put = sent.find((s) => s.name === 'PutObject');
    expect(put?.input).toMatchObject({ Bucket: 'media', Key: 'a/b.jpg', ContentType: 'image/jpeg', ContentLength: 3 });
  });

  it('writes a new object after checking it is not there', async () => {
    respond = (name) => (name === 'HeadObject' ? new Error('NotFound') : {});
    const store = s3Store(SETTINGS, 'media');
    expect(await store.put('a/b.jpg', Buffer.from('abcd'), { contentType: 'image/png' })).toEqual({ bytes: 4 });
  });

  it('reports the keys S3 could not delete', async () => {
    respond = (name) => (name === 'DeleteObjects' ? { Errors: [{ Key: 'a/2.jpg' }] } : {});
    const store = s3Store(SETTINGS, 'media');
    const r = await store.remove(['a/1.jpg', 'a/2.jpg', '../x']);
    expect(r.failed.sort()).toEqual(['../x', 'a/2.jpg']);
    const del = sent.find((s) => s.name === 'DeleteObjects');
    expect(del?.input).toMatchObject({ Bucket: 'media', Delete: { Objects: [{ Key: 'a/1.jpg' }, { Key: 'a/2.jpg' }], Quiet: true } });
  });

  it('reports every key when the delete call fails', async () => {
    respond = () => new Error('down');
    const store = s3Store(SETTINGS, 'media');
    expect((await store.remove(['a/1.jpg'])).failed).toEqual(['a/1.jpg']);
  });

  it('pages through a listing', async () => {
    let page = 0;
    respond = (name) => {
      if (name !== 'ListObjectsV2') return {};
      page += 1;
      return page === 1
        ? { Contents: [{ Key: 'p/1.jpg', Size: 1, ETag: '"e1"' }, { Key: 'p/', Size: 0 }], IsTruncated: true, NextContinuationToken: 't' }
        : { Contents: [{ Key: 'p/2.jpg', Size: 2 }], IsTruncated: false };
    };
    const store = s3Store(SETTINGS, 'media');
    expect(await store.list('p/')).toEqual([{ path: 'p/1.jpg', bytes: 1, etag: 'e1' }, { path: 'p/2.jpg', bytes: 2, etag: undefined }]);
  });

  it('reads head as not found instead of throwing', async () => {
    respond = () => new Error('NotFound');
    const store = s3Store(SETTINGS, 'media');
    expect(await store.head('a/b.jpg')).toEqual({ ok: false, bytes: 0, contentType: '' });
  });
});
