import { describe, expect, it } from 'vitest';
import {
  classifyEditorKind,
  walkFields,
  buildDefault,
  getAtPointer,
  setAtPointer,
  type SchemaNode,
} from '../walk-schema.js';

describe('classifyEditorKind()', () => {
  it('honors format=html', () => {
    expect(classifyEditorKind({ type: 'string', format: 'html' })).toBe('html');
  });

  it('honors format=media-url', () => {
    expect(classifyEditorKind({ type: 'string', format: 'media-url' })).toBe('media-url');
  });

  it('promotes long strings to textarea', () => {
    expect(classifyEditorKind({ type: 'string', maxLength: 1000 })).toBe('textarea');
  });

  it("classifies enums as select", () => {
    expect(classifyEditorKind({ type: 'string', enum: ['a', 'b'] })).toBe('select');
  });

  it("classifies primitives", () => {
    expect(classifyEditorKind({ type: 'integer' })).toBe('integer');
    expect(classifyEditorKind({ type: 'number' })).toBe('number');
    expect(classifyEditorKind({ type: 'boolean' })).toBe('boolean');
    expect(classifyEditorKind({ type: 'string' })).toBe('text');
  });
});

describe('walkFields()', () => {
  it('walks an object schema and emits descriptors per leaf and each object', () => {
    const schema: SchemaNode = {
      type: 'object',
      title: 'Page Content',
      required: ['title'],
      properties: {
        title: { type: 'string', title: 'Title' },
        body: { type: 'string', format: 'html' },
        meta: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            'show/me': { type: 'boolean' }, // tests pointer escaping
          },
        },
      },
    };
    const fields = walkFields(schema);
    expect(fields.find((f) => f.pointer === '/title')?.kind).toBe('text');
    expect(fields.find((f) => f.pointer === '/body')?.kind).toBe('html');
    expect(fields.find((f) => f.pointer === '/meta/description')?.kind).toBe('text');
    expect(fields.find((f) => f.pointer === '/meta/show~1me')?.kind).toBe('boolean');
    expect(fields.find((f) => f.pointer === '/title')?.required).toBe(true);
    expect(fields.find((f) => f.pointer === '/body')?.required).toBe(false);
  });

  it('detects x-gatewaze-personalize fields', () => {
    const schema: SchemaNode = {
      type: 'object',
      properties: {
        hero: {
          type: 'object',
          'x-gatewaze-personalize': true,
          properties: { title: { type: 'string' } },
        },
        plain: { type: 'string' },
      },
    };
    const fields = walkFields(schema);
    expect(fields.find((f) => f.pointer === '/hero')?.personalizable).toBe(true);
    expect(fields.find((f) => f.pointer === '/plain')?.personalizable).toBe(false);
  });

  it('does NOT recurse into arrays (items handled by array editor at runtime)', () => {
    const schema: SchemaNode = {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: { type: 'object', properties: { title: { type: 'string' } } },
        },
      },
    };
    const fields = walkFields(schema);
    expect(fields.find((f) => f.pointer === '/cards/items/title')).toBeUndefined();
    expect(fields.find((f) => f.pointer === '/cards')?.kind).toBe('array');
  });
});

describe('buildDefault()', () => {
  it('honors explicit defaults at any depth', () => {
    expect(
      buildDefault({
        type: 'object',
        properties: {
          title: { type: 'string', default: 'Hello' },
          count: { type: 'integer', default: 5 },
        },
      }),
    ).toEqual({ title: 'Hello', count: 5 });
  });

  it('falls back to empty values per type', () => {
    expect(buildDefault({ type: 'string' })).toBe('');
    expect(buildDefault({ type: 'integer' })).toBe(0);
    expect(buildDefault({ type: 'boolean' })).toBe(false);
    expect(buildDefault({ type: 'array' })).toEqual([]);
    expect(buildDefault({ type: 'object', properties: { x: { type: 'string' } } })).toEqual({ x: '' });
  });
});

describe('getAtPointer() / setAtPointer()', () => {
  it('returns the root for empty pointer', () => {
    expect(getAtPointer({ a: 1 }, '')).toEqual({ a: 1 });
  });

  it('descends nested objects', () => {
    expect(getAtPointer({ a: { b: { c: 42 } } }, '/a/b/c')).toBe(42);
  });

  it('returns undefined for missing keys', () => {
    expect(getAtPointer({}, '/a/b/c')).toBeUndefined();
  });

  it('descends arrays by index', () => {
    expect(getAtPointer({ items: ['a', 'b', 'c'] }, '/items/1')).toBe('b');
  });

  it('immutably updates a value', () => {
    const orig = { a: { b: 1 } };
    const next = setAtPointer(orig, '/a/b', 2);
    expect(next).toEqual({ a: { b: 2 } });
    expect(orig).toEqual({ a: { b: 1 } });   // unchanged
  });

  it('immutably updates an array element', () => {
    const orig = { items: ['x', 'y', 'z'] };
    const next = setAtPointer(orig, '/items/1', 'Y');
    expect(next).toEqual({ items: ['x', 'Y', 'z'] });
    expect(orig).toEqual({ items: ['x', 'y', 'z'] });
  });

  it('creates intermediates for previously-missing paths', () => {
    const next = setAtPointer({}, '/a/b/c', 42);
    expect(next).toEqual({ a: { b: { c: 42 } } });
  });

  it('handles pointer escapes', () => {
    const next = setAtPointer({}, '/a~1b', 1); // "/a/b" the literal key
    expect(next).toEqual({ 'a/b': 1 });
  });
});
