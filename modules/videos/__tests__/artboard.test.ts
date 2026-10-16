import { describe, it, expect } from 'vitest';
import { artboardHtml, artboardPage, clampSelection, markPosition, cutTransform, escapeHtml } from '../lib/artboard.js';

describe('clampSelection', () => {
  it('bounds every number and trims the text', () => {
    expect(clampSelection({ scale: 9, x: 0, lead: '  a   b ', emph: 'x'.repeat(100), panels: false })).toEqual({
      scale: 1.5, x: 0.4, lead: 'a b', emph: 'x'.repeat(40), panels: false,
    });
    expect(clampSelection({})).toEqual({ scale: 1, x: 0.62, lead: '', emph: '', panels: true });
    expect(clampSelection({ scale: 'nope' as never })).toMatchObject({ scale: 1 });
  });
});

describe('artboardHtml', () => {
  const base = { backgroundSrc: 'bg.jpg', logoSrc: 'logo.svg', cutSrc: 'cut.png', panelSrcs: ['p1.jpg', 'p2.jpg'], markName: 'Pydantic', cutBounds: [0.3, 0.1, 0.7, 1] as [number, number, number, number], selection: clampSelection({ lead: 'Agent <evals>', emph: 'Prod "wins"' }) };
  it('escapes everything an editor typed', () => {
    const html = artboardHtml(base);
    expect(html).toContain('Agent &lt;evals&gt;');
    expect(html).toContain('Prod &quot;wins&quot;');
    expect(html).not.toContain('<evals>');
  });
  it('lays two panels, one panel or none', () => {
    expect(artboardHtml(base)).toContain('class="card b"');
    expect(artboardHtml({ ...base, panelSrcs: ['p1.jpg'] })).toContain('class="card solo"');
    expect(artboardHtml({ ...base, selection: { ...base.selection, panels: false } })).not.toContain('class="card');
    expect(artboardHtml({ ...base, cutSrc: null })).not.toContain('class="cut"');
  });
  it('puts the company mark away from the speaker, or top right over a wide figure', () => {
    expect(markPosition(clampSelection({ x: 0.7 }), [0.3, 0, 0.6, 1])).toBe('l');
    expect(markPosition(clampSelection({ x: 0.45 }), [0.3, 0, 0.6, 1])).toBe('r');
    expect(markPosition(clampSelection({ x: 0.45 }), [0.1, 0, 0.9, 1])).toBe('tr');
    expect(artboardHtml(base)).toContain('class="mark name l"');
  });
  it('moves and scales the cut-out from the selection', () => {
    expect(cutTransform(clampSelection({ x: 0.62, scale: 1.2 }))).toBe('translateX(12.00%) scale(1.200)');
  });
  it('the page is self-contained at 1280x720 with the font inlined', () => {
    const page = artboardPage(base, { archivo: 'data:font/woff2;base64,AAAA' });
    expect(page).toContain('width: 1280px; height: 720px');
    expect(page).toContain('data:font/woff2;base64,AAAA');
    expect(page).toContain('container-type: inline-size');
  });
  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});
