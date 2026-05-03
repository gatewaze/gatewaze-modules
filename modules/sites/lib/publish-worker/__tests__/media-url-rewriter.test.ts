import { describe, expect, it, vi } from 'vitest';
import { rewriteMediaUrlsInContent, buildMediaManifest } from '../media-url-rewriter.js';

interface MediaRow {
  storage_path: string;
  in_repo: boolean;
  mime_type: string;
  bytes: number;
}

function makeStubDeps(media: MediaRow[]) {
  return {
    supabase: {
      from(_table: string) {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: async () => ({ data: media, error: null }),
              }),
            }),
          }),
        };
      },
    },
    bunnyRewriter: null,
    resolveMediaUrl: (path: string) => `https://supabase.example.com/storage/v1/object/public/${path}`,
    logger: { info: vi.fn(), warn: vi.fn() },
  };
}

describe('rewriteMediaUrlsInContent', () => {
  it('rewrites /media/foo.jpg → CDN URL when found in host_media', async () => {
    const deps = makeStubDeps([
      { storage_path: 'media/hero.jpg', in_repo: true, mime_type: 'image/jpeg', bytes: 1024 },
    ]);
    const content = { image: '/media/hero.jpg', headline: 'Welcome' };
    const result = await rewriteMediaUrlsInContent('site', 'site-1', content, deps);
    expect((result.rewrittenContent as { image: string }).image).toBe(
      'https://supabase.example.com/storage/v1/object/public/media/hero.jpg',
    );
    expect((result.rewrittenContent as { headline: string }).headline).toBe('Welcome');
  });

  it('walks nested objects + arrays', async () => {
    const deps = makeStubDeps([
      { storage_path: 'media/a.jpg', in_repo: true, mime_type: 'image/jpeg', bytes: 1024 },
      { storage_path: 'media/b.jpg', in_repo: true, mime_type: 'image/jpeg', bytes: 1024 },
    ]);
    const content = {
      blocks: [
        { content: { image: '/media/a.jpg' } },
        { content: { background_image: '/media/b.jpg' } },
      ],
    };
    const result = await rewriteMediaUrlsInContent('site', 'site-1', content, deps);
    const blocks = (result.rewrittenContent as { blocks: Array<{ content: { image?: string; background_image?: string } }> }).blocks;
    expect(blocks[0]?.content.image).toContain('media/a.jpg');
    expect(blocks[1]?.content.background_image).toContain('media/b.jpg');
  });

  it('emits manifest entry for CDN-only items (in_repo=false)', async () => {
    const deps = makeStubDeps([
      { storage_path: 'media/large.mp4', in_repo: false, mime_type: 'video/mp4', bytes: 10_485_760 },
    ]);
    const content = { src: '/media/large.mp4' };
    const result = await rewriteMediaUrlsInContent('site', 'site-1', content, deps);
    expect(result.manifestEntries).toHaveLength(1);
    expect(result.manifestEntries[0]).toMatchObject({
      path: 'media/large.mp4',
      bytes: 10_485_760,
      mime_type: 'video/mp4',
    });
  });

  it('skips manifest for in-repo items', async () => {
    const deps = makeStubDeps([
      { storage_path: 'media/small.jpg', in_repo: true, mime_type: 'image/jpeg', bytes: 1024 },
    ]);
    const content = { image: '/media/small.jpg' };
    const result = await rewriteMediaUrlsInContent('site', 'site-1', content, deps);
    expect(result.manifestEntries).toHaveLength(0);
  });

  it('leaves unknown refs unchanged + warns', async () => {
    const deps = makeStubDeps([]);
    const content = { image: '/media/missing.jpg' };
    const result = await rewriteMediaUrlsInContent('site', 'site-1', content, deps);
    expect((result.rewrittenContent as { image: string }).image).toBe('/media/missing.jpg');
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('returns empty result when no media references found', async () => {
    const deps = makeStubDeps([]);
    const content = { headline: 'No media here', body: 'Plain text' };
    const result = await rewriteMediaUrlsInContent('site', 'site-1', content, deps);
    expect(result.rewrittenContent).toEqual(content);
    expect(result.manifestEntries).toEqual([]);
  });

  it('rewrites through bunny when bunnyRewriter provided', async () => {
    const deps = {
      ...makeStubDeps([{ storage_path: 'media/hero.jpg', in_repo: true, mime_type: 'image/jpeg', bytes: 1024 }]),
      bunnyRewriter: (url: string) => url.replace('supabase.example.com', 'cdn.brand.com'),
    };
    const content = { image: '/media/hero.jpg' };
    const result = await rewriteMediaUrlsInContent('site', 'site-1', content, deps);
    expect((result.rewrittenContent as { image: string }).image).toContain('cdn.brand.com');
  });
});

describe('buildMediaManifest', () => {
  it('produces a valid JSON document with sorted entries', () => {
    const entries = [
      { path: 'media/z.jpg', sha256: null, cdn_url: 'https://cdn/z.jpg', bytes: 100, mime_type: 'image/jpeg' },
      { path: 'media/a.jpg', sha256: null, cdn_url: 'https://cdn/a.jpg', bytes: 200, mime_type: 'image/jpeg' },
    ];
    const manifest = JSON.parse(buildMediaManifest(entries));
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0].path).toBe('media/a.jpg'); // sorted
    expect(manifest.entries[1].path).toBe('media/z.jpg');
  });

  it('includes generated_at timestamp', () => {
    const manifest = JSON.parse(buildMediaManifest([]));
    expect(manifest.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
