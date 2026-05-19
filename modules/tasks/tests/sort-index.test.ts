import { describe, it, expect } from 'vitest';
import { initial, before, after, between } from '../lib/sort-index';

describe('sort-index', () => {
  it('initial is a single-char string', () => {
    const i = initial();
    expect(i.length).toBe(1);
  });

  it('between two known values lies strictly between', () => {
    const a = 'A';
    const b = 'C';
    const m = between(a, b);
    expect(m > a).toBe(true);
    expect(m < b).toBe(true);
  });

  it('before(x) sorts before x', () => {
    const x = 'M';
    const b = before(x);
    expect(b < x).toBe(true);
  });

  it('after(x) sorts after x', () => {
    const x = 'M';
    const a = after(x);
    expect(a > x).toBe(true);
  });

  it('null/null returns initial', () => {
    expect(between(null, null).length).toBeGreaterThan(0);
  });

  it('null/b returns string < b', () => {
    expect(between(null, 'M') < 'M').toBe(true);
  });

  it('a/null returns string > a', () => {
    expect(between('M', null) > 'M').toBe(true);
  });

  it('throws when a >= b', () => {
    expect(() => between('Z', 'A')).toThrow();
  });

  it('100 sequential midpoints between fixed bounds stay ordered', () => {
    let lo = 'A';
    const hi = 'z';
    const inserted: string[] = [];
    for (let i = 0; i < 100; i++) {
      const m = between(lo, hi);
      expect(m > lo).toBe(true);
      expect(m < hi).toBe(true);
      inserted.push(m);
      lo = m;
    }
    // Strictly increasing.
    for (let i = 1; i < inserted.length; i++) {
      expect(inserted[i]! > inserted[i - 1]!).toBe(true);
    }
  });
});
