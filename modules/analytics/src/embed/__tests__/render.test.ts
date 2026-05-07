import { describe, expect, it } from 'vitest';
import { renderEmbed } from '../render.js';

const PROPERTY_ID = '11111111-2222-3333-4444-555555555555';

describe('renderEmbed', () => {
  it('emits the Umami pixel script + dimension init for sites', () => {
    const out = renderEmbed({
      propertyId: PROPERTY_ID,
      kind: 'gatewaze_site',
      ingestOrigin: 'https://example.com',
      dimensions: { page_id: 'page-1', page_path: '/about' },
    });
    expect(out.head).toContain(`data-website-id="${PROPERTY_ID}"`);
    expect(out.head).toContain('data-host-url="https://example.com"');
    expect(out.head).toContain('umami.track');           // dimension init
    expect(out.head).toContain('"page_id":"page-1"');    // pre-baked
    expect(out.head).toContain('"page_path":"/about"');
  });

  it('includes operator script_head BEFORE the pixel (so GTM init wins on race)', () => {
    const out = renderEmbed({
      propertyId: PROPERTY_ID,
      kind: 'gatewaze_site',
      ingestOrigin: 'https://example.com',
      scriptHead: '<!-- gtm --><script>window.dataLayer=[];</script>',
    });
    const gtmIdx = out.head.indexOf('window.dataLayer');
    const pixelIdx = out.head.indexOf('data-website-id');
    expect(gtmIdx).toBeGreaterThan(-1);
    expect(pixelIdx).toBeGreaterThan(gtmIdx);
  });

  it('emits Segment loader when write key set', () => {
    const out = renderEmbed({
      propertyId: PROPERTY_ID,
      kind: 'gatewaze_site',
      ingestOrigin: 'https://example.com',
      segmentWriteKey: 'wk_abc123',
    });
    expect(out.head).toContain('analytics.SNIPPET_VERSION');
    expect(out.head).toContain('"wk_abc123"');
  });

  it('omits dimension init when no dimensions supplied', () => {
    const out = renderEmbed({
      propertyId: PROPERTY_ID,
      kind: 'gatewaze_site',
      ingestOrigin: 'https://example.com',
    });
    expect(out.head).not.toContain('umami.track(function');
  });

  it('skips dimension pre-bake for external properties (resolved at runtime)', () => {
    const out = renderEmbed({
      propertyId: PROPERTY_ID,
      kind: 'external',
      ingestOrigin: 'https://analytics.example.com',
      dimensions: { page_path: '/lhs' }, // ignored for external
    });
    expect(out.head).toContain('data-website-id');
    expect(out.head).not.toContain('umami.track(function');
  });

  it('puts script_body in the body output, not head', () => {
    const out = renderEmbed({
      propertyId: PROPERTY_ID,
      kind: 'gatewaze_site',
      ingestOrigin: 'https://example.com',
      scriptBody: '<noscript>noscript fallback</noscript>',
    });
    expect(out.body).toContain('<noscript>noscript fallback</noscript>');
    expect(out.head).not.toContain('<noscript>');
  });

  it('escapes </script> in user dimension values to prevent script-tag breakout', () => {
    const out = renderEmbed({
      propertyId: PROPERTY_ID,
      kind: 'gatewaze_site',
      ingestOrigin: 'https://example.com',
      dimensions: { page_path: '</script><script>alert(1)</script>' },
    });
    expect(out.head).not.toContain('</script><script>alert');
    expect(out.head).toContain('<\\/script>');
  });

  it('strips trailing slash from ingestOrigin', () => {
    const out = renderEmbed({
      propertyId: PROPERTY_ID,
      kind: 'gatewaze_site',
      ingestOrigin: 'https://example.com///',
    });
    expect(out.head).toContain('data-host-url="https://example.com"');
    expect(out.head).not.toContain('example.com//');
  });
});
