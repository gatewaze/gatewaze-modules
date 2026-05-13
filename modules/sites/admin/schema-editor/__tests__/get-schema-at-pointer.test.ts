import { describe, expect, it } from 'vitest';
import { getSchemaAtPointer, type SchemaNode } from '../walk-schema.js';

const SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    heroTitle: { type: 'string' },
    hero: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        cta: {
          type: 'object',
          properties: {
            label: { type: 'string' },
          },
        },
      },
    },
    contentBlocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string', format: 'html' },
        },
      },
    },
  },
};

describe('getSchemaAtPointer()', () => {
  it('empty pointer returns root', () => {
    expect(getSchemaAtPointer(SCHEMA, '')).toBe(SCHEMA);
  });

  it('resolves a top-level field', () => {
    expect(getSchemaAtPointer(SCHEMA, '/heroTitle')).toEqual({ type: 'string' });
  });

  it('resolves nested object fields', () => {
    expect(getSchemaAtPointer(SCHEMA, '/hero/title')).toEqual({ type: 'string' });
    expect(getSchemaAtPointer(SCHEMA, '/hero/cta/label')).toEqual({ type: 'string' });
  });

  it('numeric segment descends into items', () => {
    const itemSchema = getSchemaAtPointer(SCHEMA, '/contentBlocks/0');
    expect(itemSchema?.type).toBe('object');
    expect(itemSchema?.properties?.title).toEqual({ type: 'string' });
  });

  it('object key after array index', () => {
    expect(getSchemaAtPointer(SCHEMA, '/contentBlocks/0/title')).toEqual({ type: 'string' });
    expect(getSchemaAtPointer(SCHEMA, '/contentBlocks/2/body')).toEqual({ type: 'string', format: 'html' });
  });

  it('returns null when path misses', () => {
    expect(getSchemaAtPointer(SCHEMA, '/nope')).toBeNull();
    expect(getSchemaAtPointer(SCHEMA, '/hero/missing')).toBeNull();
  });
});
