import { describe, it, expect } from 'vitest';
import { stripPastedTextColors } from '../paste-color.js';

describe('stripPastedTextColors — issue #34 paste colour normalisation', () => {
  it('strips `color:` from an inline style, preserving the element and text', () => {
    const out = stripPastedTextColors('<span style="color:#555">hello</span>');
    expect(out).not.toMatch(/color/i);
    expect(out).toContain('hello');
    expect(out).toContain('<span');
  });

  it('strips `background-color` and the `background` shorthand', () => {
    expect(stripPastedTextColors('<p style="background-color:#eee">x</p>'))
      .not.toMatch(/background/i);
    expect(stripPastedTextColors('<p style="background:#fff">x</p>'))
      .not.toMatch(/background/i);
  });

  it('leaves other declarations intact when stripping colour', () => {
    const out = stripPastedTextColors('<span style="font-weight:bold;color:grey">x</span>');
    expect(out).toContain('font-weight:bold');
    expect(out).not.toMatch(/color/i);
  });

  it('handles rgb()/rgba()/named colours and messy spacing + casing', () => {
    expect(stripPastedTextColors('<span style="Color: RGB( 85, 85, 85 )">x</span>'))
      .not.toMatch(/rgb/i);
    expect(stripPastedTextColors('<span style="COLOR:rgba(0,0,0,.5)">x</span>'))
      .not.toMatch(/rgba/i);
    expect(stripPastedTextColors('<span style="color:  grey ">x</span>'))
      .not.toMatch(/grey/i);
  });

  it('does not touch a non-colour property that merely contains the word "color"', () => {
    const out = stripPastedTextColors('<div style="background-image:url(/color.png)">x</div>');
    expect(out).toContain('background-image:url(/color.png)');
  });

  it('never strips a non-style occurrence of the word "color"', () => {
    const out = stripPastedTextColors('<a href="https://x/color?c=1">color me</a>');
    expect(out).toBe('<a href="https://x/color?c=1">color me</a>');
  });

  it('is a no-op when there is no colour (directly-typed-text analogue)', () => {
    const html = '<p>Just some <strong>typed</strong> text</p>';
    expect(stripPastedTextColors(html)).toBe(html);
  });

  it('returns empty/undefined-ish input unchanged', () => {
    expect(stripPastedTextColors('')).toBe('');
  });

  it('drops a style attribute (and its leading space) left empty after filtering', () => {
    expect(stripPastedTextColors('<span style="color:#555">x</span>'))
      .toBe('<span>x</span>');
  });

  it('normalises a Google-Docs-style payload with no residual colour', () => {
    const gdocs =
      '<b style="font-weight:normal"><span style="color:#666666;font-style:normal">' +
      'Pasted from Docs</span></b>';
    const out = stripPastedTextColors(gdocs);
    expect(out).not.toMatch(/color/i);
    expect(out).toContain('font-weight:normal');
    expect(out).toContain('font-style:normal');
    expect(out).toContain('Pasted from Docs');
  });

  it('strips a deliberate brand-blue span too — proof it MUST stay paste-scoped', () => {
    // The helper unconditionally strips colour, so wiring it anywhere other
    // than `transformPastedHTML` (e.g. onto load of a stored value) would drop
    // operator-chosen colours. This test pins that invariant.
    expect(stripPastedTextColors('<span style="color:#4086c6">brand</span>'))
      .toBe('<span>brand</span>');
  });

  it('preserves multiple non-colour declarations across several elements', () => {
    const out = stripPastedTextColors(
      '<span style="color:red;font-size:14px">a</span>' +
        '<span style="text-align:center;background:#000">b</span>',
    );
    expect(out).not.toMatch(/color|background/i);
    expect(out).toContain('font-size:14px');
    expect(out).toContain('text-align:center');
  });
});
