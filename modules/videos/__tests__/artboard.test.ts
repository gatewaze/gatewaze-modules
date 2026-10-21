import { describe, it, expect } from 'vitest';
import { artboardHtml, artboardPage, clampSelection, markPosition, cutPlacement, headPoint, escapeHtml } from '../lib/artboard.js';

describe('clampSelection', () => {
  it('bounds every number and trims the text', () => {
    expect(clampSelection({ scale: 9, x: 0, y: 2, lead: '  a   b ', emph: 'x'.repeat(100), panels: false })).toEqual({
      scale: 1.5, x: 0.4, y: 0.75, lead: 'a b', emph: 'x'.repeat(40), panels: false,
    });
    expect(clampSelection({})).toEqual({ scale: 1, x: 0.62, y: null, lead: '', emph: '', panels: true });
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
  it('puts the company logo away from the speaker, or top right over a wide figure, and shows no name without one', () => {
    expect(markPosition(clampSelection({ x: 0.7 }), [0.3, 0, 0.6, 1])).toBe('l');
    expect(markPosition(clampSelection({ x: 0.45 }), [0.3, 0, 0.6, 1])).toBe('r');
    expect(markPosition(clampSelection({ x: 0.45 }), [0.1, 0, 0.9, 1])).toBe('tr');
    expect(artboardHtml(base)).not.toContain('class="mark');
    expect(artboardHtml({ ...base, markSrc: 'logo.png' })).toContain('class="mark l" src="logo.png"');
  });
  it('anchors the cut-out on the head: scaling keeps the head where it is, and the head never leaves the frame', () => {
    const bbox: [number, number, number, number] = [0.4, 0.1, 0.8, 1];
    expect(headPoint(bbox).hx).toBeCloseTo(0.6, 6);
    expect(headPoint(bbox).hy).toBeCloseTo(0.172, 6);
    const natural = cutPlacement(clampSelection({ x: 0.6, scale: 1.5 }), bbox);
    expect(natural.origin).toBe('60.00% 17.20%');
    expect(natural.transform).toBe('translate(0.00%, 0.00%) scale(1.500)');
    // Asked to put the head far up and left: clamped to the picture.
    const clamped = cutPlacement(clampSelection({ x: 0.4, y: 0.05, scale: 1 }), bbox);
    expect(clamped.transform).toBe('translate(-20.00%, -12.20%) scale(1.000)');
    // Shrinking pushes the figure down so the feet stay on the floor.
    const small = cutPlacement(clampSelection({ x: 0.6, scale: 0.7 }), bbox);
    expect(small.transform).toBe('translate(0.00%, 24.84%) scale(0.700)');
    expect(artboardHtml(base)).toContain('transform-origin:');
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
