import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downloadAttachmentUrls,
  downloadIssueAttachments,
  isAllowedAttachmentUrl,
  extractImageUrls,
  ATTACH_DIRNAME,
} from '../attachments.js';

// A real 1x1 PNG header (>=12 bytes) so sniffImage() accepts it by magic bytes.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x00]);

const SUPA = 'https://storage.example.supabase.co';

/** A minimal Response stand-in for the allowlisted-image happy path. */
function imageResponse(body: Buffer = PNG) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(body.length) : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

describe('attachments', () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'se-attach-'));
    process.env.SUPABASE_URL = SUPA;
    fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal('fetch', fetchMock as any);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    await rm(dir, { recursive: true, force: true });
  });

  describe('downloadAttachmentUrls', () => {
    it('downloads an allowlisted image and applies the filename prefix', async () => {
      const r = await downloadAttachmentUrls([`${SUPA}/media/a.png`], null, dir, { prefix: 'chat1-' });
      expect(r.count).toBe(1);
      expect(r.names).toEqual(['chat1-screenshot-1.png']);
      expect(await readdir(join(dir, ATTACH_DIRNAME))).toEqual(['chat1-screenshot-1.png']);
      expect(await readFile(join(dir, ATTACH_DIRNAME, r.names[0]))).toEqual(PNG);
    });

    it('never fetches a non-allowlisted host (SSRF entry guard)', async () => {
      const r = await downloadAttachmentUrls(['https://evil.example.com/x.png'], null, dir);
      expect(r.count).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a private / metadata host outright', async () => {
      const r = await downloadAttachmentUrls(['https://169.254.169.254/latest.png'], null, dir);
      expect(r.count).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects non-image bytes even from an allowlisted host (magic-byte validation)', async () => {
      fetchMock.mockResolvedValueOnce(imageResponse(Buffer.from('<html>not an image</html>')));
      const r = await downloadAttachmentUrls([`${SUPA}/media/evil.png`], null, dir);
      expect(r.count).toBe(0);
    });

    it('caps the number of files at 8', async () => {
      const urls = Array.from({ length: 12 }, (_, i) => `${SUPA}/media/${i}.png`);
      const r = await downloadAttachmentUrls(urls, null, dir);
      expect(r.count).toBe(8);
      expect(fetchMock).toHaveBeenCalledTimes(8);
    });

    it('does NOT send the PAT to the public media bucket, only to GitHub hosts', async () => {
      await downloadAttachmentUrls([`${SUPA}/media/a.png`], 'ghp_secret', dir);
      const [, init] = fetchMock.mock.calls[0];
      expect((init?.headers ?? {}).Authorization).toBeUndefined();

      fetchMock.mockClear();
      await downloadAttachmentUrls(['https://user-images.githubusercontent.com/1/x.png'], 'ghp_secret', dir);
      const [, ghInit] = fetchMock.mock.calls[0];
      expect((ghInit?.headers ?? {}).Authorization).toBe('Bearer ghp_secret');
    });

    it('returns empty for an empty / non-string list without touching the fs', async () => {
      const r = await downloadAttachmentUrls([], null, dir);
      expect(r).toEqual({ count: 0, dir: null, names: [] });
      // @ts-expect-error — exercising non-string input filtering
      const r2 = await downloadAttachmentUrls([null, 123, ''], null, dir);
      expect(r2.count).toBe(0);
    });
  });

  describe('downloadIssueAttachments delegates to the shared downloader', () => {
    it('extracts markdown image URLs and downloads the allowlisted ones', async () => {
      const body = `See ![shot](${SUPA}/media/a.png) and ![bad](https://evil.example.com/b.png)`;
      const r = await downloadIssueAttachments(body, null, dir);
      expect(r.count).toBe(1);
      expect(r.names).toEqual(['screenshot-1.png']);   // no prefix on the issue path
    });
  });

  describe('isAllowedAttachmentUrl', () => {
    it('accepts a clean allowlisted URL', () => {
      expect(isAllowedAttachmentUrl(`${SUPA}/media/a.png`)).toBe(true);
    });
    it('rejects non-allowlisted hosts and non-https', () => {
      expect(isAllowedAttachmentUrl('https://evil.example.com/a.png')).toBe(false);
      expect(isAllowedAttachmentUrl(`http://storage.example.supabase.co/a.png`)).toBe(false);
    });
    it('rejects URLs carrying markdown-breaking / control characters', () => {
      expect(isAllowedAttachmentUrl(`${SUPA}/media/a.png) ![x](evil`)).toBe(false);
      expect(isAllowedAttachmentUrl(`${SUPA}/media/a\npng`)).toBe(false);
    });
  });

  describe('extractImageUrls', () => {
    it('captures markdown and <img> sources, de-duplicated', () => {
      const body = `![a](${SUPA}/1.png)\n<img src="${SUPA}/2.png">\n![dup](${SUPA}/1.png)`;
      expect(extractImageUrls(body)).toEqual([`${SUPA}/1.png`, `${SUPA}/2.png`]);
    });
  });
});
