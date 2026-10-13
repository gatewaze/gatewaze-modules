import { describe, expect, it } from 'vitest';
import { applyPreheader, previewBlock } from '../preheader.js';

// Exactly what react-email's <Preview>Hello &amp; &lt;world&gt;</Preview> renders
// (captured from @react-email/render), so the helper's output is interchangeable.
const PAD = ' ‌​‍‎‏﻿';
const REACT_EMAIL_PREVIEW = `<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" data-skip-in-text="true">Hello &amp; &lt;world&gt;<div>${PAD.repeat(150 - 'Hello & <world>'.length)}</div></div>`;
const DOC = (inner: string) => `<!DOCTYPE html><html dir="ltr" lang="en"><head><meta charset="utf-8"/></head><body style="margin:0"><!--$-->${inner}<table><tr><td><p>Body text</p></td></tr></table></body></html>`;

describe('previewBlock', () => {
  it('matches react-email <Preview> output byte for byte', () => {
    expect(previewBlock('Hello & <world>')).toBe(REACT_EMAIL_PREVIEW);
  });

  it('caps at 150 characters with no padding at the cap', () => {
    const long = 'x'.repeat(200);
    expect(previewBlock(long)).toBe(`<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" data-skip-in-text="true">${'x'.repeat(150)}</div>`);
  });
});

describe('applyPreheader', () => {
  it('inserts the block straight after <body> when the HTML has none (content saved before the preheader)', () => {
    const out = applyPreheader(DOC(''), 'New issue inside');
    expect(out).toContain('<body style="margin:0"><div style="display:none;');
    expect(out).toContain('data-skip-in-text="true">New issue inside<div>');
    expect(out).toContain('<p>Body text</p>');
  });

  it('replaces an existing block rather than adding a second one', () => {
    const out = applyPreheader(DOC(REACT_EMAIL_PREVIEW), 'Updated preview');
    expect(out.match(/data-skip-in-text="true"/g)).toHaveLength(1);
    expect(out).toContain('>Updated preview<div>');
    expect(out).not.toContain('Hello &amp;');
  });

  it('is idempotent', () => {
    const once = applyPreheader(DOC(''), 'Same');
    expect(applyPreheader(once, 'Same')).toBe(once);
  });

  it('removes the block for a blank or whitespace preheader', () => {
    for (const p of [null, undefined, '', '   ']) {
      expect(applyPreheader(DOC(REACT_EMAIL_PREVIEW), p)).toBe(DOC(''));
    }
  });

  it('escapes the preheader so it cannot inject markup', () => {
    const out = applyPreheader(DOC(''), '<img src=x onerror=alert(1)> "quoted"');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;');
  });

  it('prepends when there is no <body> tag (body-only HTML)', () => {
    expect(applyPreheader('<p>hi</p>', 'Preview')).toMatch(/^<div style="display:none;[^"]*" data-skip-in-text="true">Preview<div>/);
  });

  it('leaves other hidden divs alone', () => {
    const other = '<div style="display:none">tracking</div>';
    expect(applyPreheader(DOC(other), 'P')).toContain(other);
  });
});
