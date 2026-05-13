import { describe, expect, it } from 'vitest';
import { jsonPointerToFieldPath, fieldPathToJsonPointer } from '../field-path.js';

describe('jsonPointerToFieldPath()', () => {
  it('empty pointer → empty path', () => {
    expect(jsonPointerToFieldPath('')).toBe('');
  });

  it('single-segment object key', () => {
    expect(jsonPointerToFieldPath('/heroTitle')).toBe('heroTitle');
  });

  it('nested object keys join with dots', () => {
    expect(jsonPointerToFieldPath('/hero/title')).toBe('hero.title');
  });

  it('array index becomes [n]', () => {
    expect(jsonPointerToFieldPath('/contentBlocks/2')).toBe('contentBlocks[2]');
  });

  it('object key after array index', () => {
    expect(jsonPointerToFieldPath('/contentBlocks/2/title')).toBe('contentBlocks[2].title');
  });

  it('unescapes ~1 to /', () => {
    expect(jsonPointerToFieldPath('/path~1with~1slashes/x')).toBe('path/with/slashes.x');
  });

  it('rejects non-pointer input', () => {
    expect(() => jsonPointerToFieldPath('heroTitle')).toThrow();
  });
});

describe('fieldPathToJsonPointer()', () => {
  it('empty path → empty pointer', () => {
    expect(fieldPathToJsonPointer('')).toBe('');
  });

  it('single key', () => {
    expect(fieldPathToJsonPointer('heroTitle')).toBe('/heroTitle');
  });

  it('dotted path', () => {
    expect(fieldPathToJsonPointer('hero.title')).toBe('/hero/title');
  });

  it('array index', () => {
    expect(fieldPathToJsonPointer('contentBlocks[2]')).toBe('/contentBlocks/2');
  });

  it('full compound path', () => {
    expect(fieldPathToJsonPointer('contentBlocks[2].title')).toBe('/contentBlocks/2/title');
  });

  it('rejects unterminated bracket', () => {
    expect(() => fieldPathToJsonPointer('contentBlocks[2')).toThrow();
  });

  it('rejects non-numeric bracket content', () => {
    expect(() => fieldPathToJsonPointer('blocks[a]')).toThrow();
  });

  it('round-trips through jsonPointerToFieldPath', () => {
    const cases = ['heroTitle', 'hero.title', 'contentBlocks[2]', 'contentBlocks[2].title'];
    for (const fp of cases) {
      expect(jsonPointerToFieldPath(fieldPathToJsonPointer(fp))).toBe(fp);
    }
  });
});
