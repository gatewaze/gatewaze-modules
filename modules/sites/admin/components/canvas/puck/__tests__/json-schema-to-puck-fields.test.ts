// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it } from 'vitest';
import { jsonSchemaToPuckFields, defaultsFromSchema } from '../json-schema-to-puck-fields.js';

describe('jsonSchemaToPuckFields — base types', () => {
  it('maps string (no format) to text', () => {
    const { fields, warnings } = jsonSchemaToPuckFields({
      type: 'object',
      properties: { headline: { type: 'string' } },
    });
    expect(fields.headline).toEqual({ type: 'text', label: undefined });
    expect(warnings).toEqual([]);
  });

  it('maps string with format=textarea', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: { body: { type: 'string', format: 'textarea', title: 'Body' } },
    });
    expect(fields.body).toEqual({ type: 'textarea', label: 'Body' });
  });

  it('maps integer to number', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: { columns: { type: 'integer' } },
    });
    expect(fields.columns.type).toBe('number');
  });

  it('maps boolean to radio', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: { wide: { type: 'boolean' } },
    });
    expect(fields.wide).toMatchObject({ type: 'radio' });
    expect(fields.wide.options).toEqual([
      { label: 'Yes', value: true },
      { label: 'No', value: false },
    ]);
  });
});

describe('jsonSchemaToPuckFields — custom formats', () => {
  it.each(['richtext', 'image', 'link', 'color'] as const)(
    'tags %s as customFormat',
    (fmt) => {
      const { fields, warnings } = jsonSchemaToPuckFields({
        type: 'object',
        properties: { x: { type: 'string', format: fmt } },
      });
      expect(fields.x).toMatchObject({ type: 'custom', customFormat: fmt });
      expect(warnings).toEqual([]);
    },
  );

  it('warns on unknown format and falls back to text', () => {
    const { fields, warnings } = jsonSchemaToPuckFields({
      type: 'object',
      properties: { weird: { type: 'string', format: 'gradient' } },
    });
    expect(fields.weird.type).toBe('text');
    expect(warnings).toEqual([
      { fieldPath: 'weird', reason: 'unknown string format: gradient', fallback: 'text' },
    ]);
  });
});

describe('jsonSchemaToPuckFields — composites', () => {
  it('maps enum to select regardless of base type', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: { level: { type: 'string', enum: ['h1', 'h2', 'h3'] } },
    });
    expect(fields.level).toMatchObject({
      type: 'select',
      options: [
        { label: 'h1', value: 'h1' },
        { label: 'h2', value: 'h2' },
        { label: 'h3', value: 'h3' },
      ],
    });
  });

  it('maps object to nested objectFields', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: {
        cta: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            href: { type: 'string', format: 'link' },
          },
        },
      },
    });
    expect(fields.cta.type).toBe('object');
    expect(fields.cta.objectFields.label.type).toBe('text');
    expect(fields.cta.objectFields.href).toMatchObject({
      type: 'custom',
      customFormat: 'link',
    });
  });

  it('maps array of objects to arrayFields', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' } } },
        },
      },
    });
    expect(fields.items.type).toBe('array');
    expect(fields.items.arrayFields.label.type).toBe('text');
  });

  it('warns on array of scalars', () => {
    const { fields, warnings } = jsonSchemaToPuckFields({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    });
    expect(fields.tags.type).toBe('text');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/non-object items/);
  });
});

describe('defaultsFromSchema', () => {
  it('extracts defaults from top-level properties', () => {
    const out = defaultsFromSchema({
      type: 'object',
      properties: {
        level: { type: 'string', default: 'h2' },
        tight: { type: 'boolean', default: false },
        nodefault: { type: 'string' },
      },
    });
    expect(out).toEqual({ level: 'h2', tight: false });
  });

  it('returns {} for malformed input', () => {
    expect(defaultsFromSchema(null)).toEqual({});
    expect(defaultsFromSchema('not-a-schema')).toEqual({});
    expect(defaultsFromSchema({})).toEqual({});
  });
});

describe('jsonSchemaToPuckFields — x-gatewaze-personalize', () => {
  it('flags personalizable text fields', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: {
        heroTitle: { type: 'string', 'x-gatewaze-personalize': true },
        plain: { type: 'string' },
      },
    });
    expect(fields.heroTitle).toMatchObject({ type: 'text', personalizable: true });
    expect(fields.plain).toMatchObject({ type: 'text' });
    expect((fields.plain as { personalizable?: unknown }).personalizable).toBeUndefined();
  });

  it('flags personalizable select fields', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: {
        size: { type: 'string', enum: ['small', 'large'], 'x-gatewaze-personalize': true },
      },
    });
    expect(fields.size).toMatchObject({ type: 'select', personalizable: true });
  });

  it('flags personalizable custom-format fields (richtext)', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: {
        body: { type: 'string', format: 'richtext', 'x-gatewaze-personalize': true },
      },
    });
    expect(fields.body).toMatchObject({ type: 'custom', customFormat: 'richtext', personalizable: true });
  });

  it('does not flag fields without the marker', () => {
    const { fields } = jsonSchemaToPuckFields({
      type: 'object',
      properties: {
        a: { type: 'string', 'x-gatewaze-personalize': false },
        b: { type: 'string' },
      },
    });
    expect((fields.a as { personalizable?: unknown }).personalizable).toBeUndefined();
    expect((fields.b as { personalizable?: unknown }).personalizable).toBeUndefined();
  });
});
