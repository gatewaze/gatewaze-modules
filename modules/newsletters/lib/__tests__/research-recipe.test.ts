import { describe, expect, it } from 'vitest';
import { validateItems, sanitizeInline, ResearchRecipeError } from '../research-recipe.js';

const kind = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return e instanceof ResearchRecipeError ? e.kind : `not a ResearchRecipeError: ${String(e)}`; }
};

describe('validateItems', () => {
  const inputByKey = new Map([['a.example/post', { url: 'https://a.example/post' }]]);
  const inputKeys = new Set(inputByKey.keys());

  it('takes the url from the input item that owns the key, never from the model', () => {
    const out = validateItems([{ key: 'a.example/post', headline: 'A', url: 'https://evil.example/phish' }], { inputKeys, inputByKey });
    expect(out).toEqual([{ key: 'a.example/post', headline: 'A', url: 'https://a.example/post' }]);
  });

  it('the input url wins even when the model sends a non-https one', () => {
    const out = validateItems([{ key: 'a.example/post', url: 'javascript:alert(1)' }], { inputKeys, inputByKey });
    expect(out[0].url).toBe('https://a.example/post');
  });

  it('a key that is not in the input set throws output_invalid', () => {
    expect(kind(() => validateItems([{ key: 'made.up/key', headline: 'X' }], { inputKeys, inputByKey }))).toBe('output_invalid');
    expect(kind(() => validateItems([{ headline: 'no key at all' }], { inputKeys, inputByKey }))).toBe('output_invalid');
  });

  it('a javascript: or http: url throws (pure recipe input, no owner to take it from)', () => {
    expect(kind(() => validateItems([{ key: 'k', url: 'javascript:alert(1)' }], { inputKeys: null }))).toBe('output_invalid');
    expect(kind(() => validateItems([{ key: 'k', url: 'http://plain.example/x' }], { inputKeys: null }))).toBe('output_invalid');
    expect(validateItems([{ key: 'k', url: 'https://ok.example/x' }], { inputKeys: null })[0].url).toBe('https://ok.example/x');
  });

  it('duplicate keys throw', () => {
    expect(kind(() => validateItems([{ key: 'k', headline: '1' }, { key: 'k', headline: '2' }], { inputKeys: null }))).toBe('output_invalid');
  });

  it('fields outside the allow-list are dropped; strings are sanitised with no anchors', () => {
    const out = validateItems([{ key: 'k', headline: '<a href="https://x.example">t</a><b>b</b>', onclick: 'x()', html: '<script>', style: 'x' }], { inputKeys: null });
    expect(Object.keys(out[0]).sort()).toEqual(['headline', 'key']);
    expect(out[0].headline).toBe('t<b>b</b>');
  });

  it('a non-scalar field throws', () => {
    expect(kind(() => validateItems([{ key: 'k', headline: { nested: true } }], { inputKeys: null }))).toBe('output_invalid');
  });

  it('caps the list at 500 items', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ key: `k${i}`, headline: `H${i}` }));
    const out = validateItems(many, { inputKeys: null });
    expect(out).toHaveLength(500);
    expect(out[499].key).toBe('k499');
  });

  it('accepts { items: [...] } and refuses anything that is not a list', () => {
    expect(validateItems({ items: [{ key: 'k' }] }, { inputKeys: null })).toEqual([{ key: 'k' }]);
    expect(kind(() => validateItems({ nope: 1 }, { inputKeys: null }))).toBe('output_invalid');
  });
});

describe('sanitizeInline', () => {
  it('input cannot forge the internal placeholder marker', () => {
    const out = sanitizeInline('<a href="https://ok.example">x</a>\u00000\u0000', { allowAnchors: true });
    expect(out).toBe('<a href="https://ok.example" rel="noopener nofollow">x</a>0');
  });
});

describe('validateItems takes dates from the input owner', () => {
  it('copies published_at, date_label and foundation from the input, overriding the model', async () => {
    const { validateItems } = await import('../research-recipe.js');
    const inputByKey = new Map([['a.org/x', { url: 'https://a.org/x', published_at: '2026-10-15T00:00:00Z', date_label: '15 Oct', foundation: 'CNCF' }]]);
    const out = validateItems([{ key: 'a.org/x', headline: 'H', url: 'https://evil.example/', published_at: '1999-01-01' }], { inputKeys: new Set(['a.org/x']), inputByKey });
    expect(out[0]).toMatchObject({ url: 'https://a.org/x', published_at: '2026-10-15T00:00:00Z', date_label: '15 Oct', foundation: 'CNCF' });
  });
});
