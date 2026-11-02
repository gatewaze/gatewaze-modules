// No mocks: a real presign with the real SDK. Presigning is offline, so no
// request leaves the machine.
import { describe, expect, it } from 'vitest';
import { s3Store } from '../s3-store.js';

const store = s3Store({
  provider: 'r2',
  endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  publicBaseUrl: 'https://media.example.com',
  resize: 'none',
}, 'media');

describe('a real presigned upload', () => {
  it('signs the content type and the size, so neither can be swapped', async () => {
    const up = await store.signUpload('event/e1/m1/a.jpg', { contentType: 'image/jpeg', bytes: 1234 });
    const signed = new URL(up.url).searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];
    expect(signed).toEqual(expect.arrayContaining(['content-type', 'content-length', 'host']));
    expect(up.headers).toEqual({ 'content-type': 'image/jpeg' });
  });

  it('expires in fifteen minutes unless asked otherwise, and never after two hours', async () => {
    const exp = async (o: { expiresSeconds?: number }) => Number(new URL((await store.signUpload('a/b.jpg', { contentType: 'image/jpeg', ...o })).url).searchParams.get('X-Amz-Expires'));
    expect(await exp({})).toBe(900);
    expect(await exp({ expiresSeconds: 7 * 24 * 3600 })).toBe(7200);
  });
});
