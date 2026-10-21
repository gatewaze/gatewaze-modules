// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { previewHtml, httpsOnly } from '../previewHtml';

describe('previewHtml', () => {
  it('keeps the readable body', () => {
    const out = previewHtml('<h2>Title</h2><p>Some <strong>bold</strong> text.</p><ul><li>one</li></ul><pre><code>x = 1</code></pre>');
    expect(out).toBe('<h2>Title</h2><p>Some <strong>bold</strong> text.</p><ul><li>one</li></ul><pre><code>x = 1</code></pre>');
  });

  it('strips scripts, handlers, styles, iframes and forms', () => {
    const out = previewHtml('<p onclick="x()" style="color:red">hi</p><script>alert(1)</script><iframe src="https://x.org"></iframe><form><input></form><img src="https://x.org/a.png" onerror="alert(1)"><svg><script>1</script></svg>');
    expect(out).not.toMatch(/onclick|onerror|style=|<script|<iframe|<form|<input|<svg/i);
    expect(out).toContain('<p>hi</p>');
  });

  it('only https (or mailto) links survive, and they open in a new tab without an opener', () => {
    const out = previewHtml('<a href="javascript:alert(1)">a</a><a href="data:text/html,x">b</a><a href="http://x.org/">c</a><a href="/rel">d</a><a href="https://x.org/ok">e</a><a href="mailto:a@x.org">f</a>');
    expect(out).not.toMatch(/javascript:|data:|http:\/\/|href="\/rel"/);
    expect(out).toContain('<a href="https://x.org/ok" target="_blank" rel="noopener noreferrer nofollow">e</a>');
    expect(out).toContain('href="mailto:a@x.org"');
  });

  it('drops images without an absolute https src and makes the rest lazy and referrer-free', () => {
    const out = previewHtml('<img src="http://x.org/a.png"><img src="data:image/png;base64,AAAA"><img src="/local.png"><img src="https://x.org/ok.png" alt="ok">');
    expect((out.match(/<img/g) || []).length).toBe(1);
    expect(out).toMatch(/<img src="https:\/\/x\.org\/ok\.png" alt="ok" loading="lazy" referrerpolicy="no-referrer">/);
  });

  it('empty input is an empty string', () => {
    expect(previewHtml(null)).toBe('');
    expect(previewHtml('')).toBe('');
  });
});

describe('httpsOnly', () => {
  it('passes https and refuses the rest', () => {
    expect(httpsOnly('https://x.org/a')).toBe('https://x.org/a');
    for (const bad of ['javascript:alert(1)', 'http://x.org/', '/a', 'https://u:p@x.org/', '', null, undefined]) expect(httpsOnly(bad)).toBeNull();
  });
});
