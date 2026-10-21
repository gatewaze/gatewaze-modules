import { describe, it, expect } from 'vitest';
import { httpsUrlOrNull, shapeDetail, DETAIL_BODY_MAX, DETAIL_CONTENT_TYPE_RE, DETAIL_UUID_RE } from '../detail';

describe('httpsUrlOrNull', () => {
  it('keeps absolute https URLs', () => {
    expect(httpsUrlOrNull('https://www.linuxfoundation.org/blog/a-post')).toBe('https://www.linuxfoundation.org/blog/a-post');
    expect(httpsUrlOrNull('  https://x.org/a b  ')).toBe('https://x.org/a%20b');
  });
  it('drops every other scheme, credentials, relative and over-long values', () => {
    for (const bad of [
      'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>1</script>', 'http://x.org/',
      'vbscript:x', '//x.org/a', '/relative', 'https://u:p@x.org/', `https://x.org/${'a'.repeat(2050)}`,
      '', '   ', null, undefined, 42, {},
    ]) {
      expect(httpsUrlOrNull(bad)).toBeNull();
    }
  });
});

describe('shapeDetail', () => {
  it('polices both URLs and caps the body', () => {
    const d = shapeDetail({ url: 'javascript:alert(1)', image_url: 'https://cdn.x.org/i.png', body_html: 'x'.repeat(DETAIL_BODY_MAX + 10), extra: 'ignored' });
    expect(d).toEqual({ url: null, image_url: 'https://cdn.x.org/i.png', body_html: 'x'.repeat(DETAIL_BODY_MAX) });
  });
  it('null for nothing, empty bodies become null', () => {
    expect(shapeDetail(null)).toBeNull();
    expect(shapeDetail([1])).toBeNull();
    expect(shapeDetail('str')).toBeNull();
    expect(shapeDetail({ url: 'https://x.org/', body_html: '  ' })).toEqual({ url: 'https://x.org/', image_url: null, body_html: null });
  });
});

describe('route params', () => {
  it('content_type is a lowercase identifier and content_id a uuid', () => {
    expect(DETAIL_CONTENT_TYPE_RE.test('blog_post')).toBe(true);
    for (const bad of ['Blog', 'blog-post', 'blog_post;drop', '', 'a'.repeat(65), '../x']) expect(DETAIL_CONTENT_TYPE_RE.test(bad)).toBe(false);
    expect(DETAIL_UUID_RE.test('0b6c2f9e-5f7a-4d4b-9a51-1f2e3d4c5b6a')).toBe(true);
    expect(DETAIL_UUID_RE.test('0b6c2f9e-5f7a-4d4b-9a51-1f2e3d4c5b6a,1')).toBe(false);
  });
});
