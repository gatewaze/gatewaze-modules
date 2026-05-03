import { describe, expect, it } from 'vitest';
import { EMBED_PROVIDERS, buildEmbedHtml, listEmbedProviders } from '../embed.js';

describe('EMBED_PROVIDERS', () => {
  it('has 9 v1 providers', () => {
    expect(Object.keys(EMBED_PROVIDERS)).toHaveLength(9);
    expect(listEmbedProviders()).toHaveLength(9);
  });

  describe('youtube', () => {
    it('builds standard embed URL', () => {
      const url = EMBED_PROVIDERS.youtube.buildSrc('dQw4w9WgXcQ');
      expect(url).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });

    it('appends autoplay + start params', () => {
      const url = EMBED_PROVIDERS.youtube.buildSrc('abc123', { autoplay: true, start: 60 });
      expect(url).toContain('autoplay=1');
      expect(url).toContain('start=60');
    });

    it('omits controls=0 when controls=true (default)', () => {
      const url = EMBED_PROVIDERS.youtube.buildSrc('abc123', { controls: true });
      expect(url).not.toContain('controls');
    });
  });

  describe('vimeo', () => {
    it('builds player URL', () => {
      const url = EMBED_PROVIDERS.vimeo.buildSrc('76979871');
      expect(url).toBe('https://player.vimeo.com/video/76979871');
    });
  });

  describe('spotify', () => {
    it('converts URI to embed path', () => {
      const url = EMBED_PROVIDERS.spotify.buildSrc('spotify:track:6rqhFgbbKwnb9MLmUQDhG6');
      expect(url).toBe('https://open.spotify.com/embed/track/6rqhFgbbKwnb9MLmUQDhG6');
    });

    it('falls back to track for raw IDs', () => {
      const url = EMBED_PROVIDERS.spotify.buildSrc('rawid');
      expect(url).toContain('embed/track/rawid');
    });
  });

  describe('codepen', () => {
    it('rewrites username/penid to embed path', () => {
      const url = EMBED_PROVIDERS.codepen.buildSrc('chriscoyier/PNaGbb');
      expect(url).toBe('https://codepen.io/chriscoyier/embed/PNaGbb?default-tab=result');
    });

    it('respects defaultTab option', () => {
      const url = EMBED_PROVIDERS.codepen.buildSrc('user/abc', { defaultTab: 'js' });
      expect(url).toContain('default-tab=js');
    });
  });
});

describe('buildEmbedHtml', () => {
  it('emits responsive aspect-ratio wrapper for percent height', () => {
    const html = buildEmbedHtml({ provider: 'youtube', contentId: 'abc' });
    expect(html).toContain('class="gatewaze-embed-wrapper"');
    expect(html).toContain('padding-top:56.25%'); // 9/16 * 100
    expect(html).toContain('<iframe');
  });

  it('escapes HTML in src + title', () => {
    const html = buildEmbedHtml({
      provider: 'youtube',
      contentId: 'abc"><script>alert(1)</script>',
      title: '<malicious>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;malicious&gt;');
  });

  it('emits allowfullscreen for video providers', () => {
    const html = buildEmbedHtml({ provider: 'youtube', contentId: 'abc' });
    expect(html).toContain('allowfullscreen');
  });

  it('emits allow attribute with provider permissions', () => {
    const html = buildEmbedHtml({ provider: 'vimeo', contentId: 'abc' });
    expect(html).toContain('allow="autoplay');
  });

  it('returns comment for unknown provider', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html = buildEmbedHtml({ provider: 'instagram' as any, contentId: 'abc' });
    expect(html).toContain('unknown embed provider');
  });

  it('respects fixed pixel height (no responsive wrapper)', () => {
    const html = buildEmbedHtml({ provider: 'youtube', contentId: 'abc', height: '480px' });
    expect(html).not.toContain('aspect-ratio');
    expect(html).toContain('height:480px');
  });
});
