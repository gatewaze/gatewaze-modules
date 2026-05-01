import { describe, expect, it } from 'vitest';
import { validateContentSchema } from '../validate.js';
import { classifySchemaDrift } from '../classify-drift.js';
import { walkPersonalizationAxes, appliedAxesForField } from '../walk-personalization.js';

// ---------------------------------------------------------------------------
// validateContentSchema
// ---------------------------------------------------------------------------

describe('validateContentSchema()', () => {
  it('accepts a minimal valid schema', () => {
    const result = validateContentSchema({
      type: 'object',
      properties: {
        routes: {
          type: 'object',
          properties: {
            '/': { type: 'object', properties: { title: { type: 'string' } } },
            '/about': { type: 'object', properties: { title: { type: 'string' } } },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.routes).toEqual(['/', '/about']);
  });

  it('rejects a non-object input', () => {
    const result = validateContentSchema('not an object');
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('templates.content_schema.not_object');
  });

  it('rejects when top-level type != object', () => {
    const result = validateContentSchema({ type: 'string' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'templates.content_schema.top_level_not_object_type')).toBe(true);
  });

  it('rejects when properties.routes is missing', () => {
    const result = validateContentSchema({
      type: 'object',
      properties: { other: { type: 'string' } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'templates.content_schema.missing_routes_property')).toBe(true);
  });

  it('rejects when routes declares no entries', () => {
    const result = validateContentSchema({
      type: 'object',
      properties: { routes: { type: 'object', properties: {} } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'templates.content_schema.no_routes_declared')).toBe(true);
  });

  it('accepts patternProperties-style routes', () => {
    const result = validateContentSchema({
      type: 'object',
      properties: {
        routes: {
          type: 'object',
          patternProperties: {
            '^/for/[a-z]+$': { type: 'object' },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.routes).toEqual(['<pattern:^/for/[a-z]+$>']);
  });

  it('rejects route patterns that do not start with /', () => {
    const result = validateContentSchema({
      type: 'object',
      properties: {
        routes: {
          type: 'object',
          properties: { 'about': { type: 'object' } },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'templates.content_schema.route_pattern_invalid')).toBe(true);
  });

  it('escapes / in JSON Pointer for route names', () => {
    const result = validateContentSchema({
      type: 'object',
      properties: {
        routes: {
          type: 'object',
          properties: { '/for/developer': 'not-an-object' },
        },
      },
    });
    expect(result.errors.some((e) => e.pointer.includes('~1for~1developer'))).toBe(true);
  });

  it('warns when a route schema has non-object type', () => {
    const result = validateContentSchema({
      type: 'object',
      properties: {
        routes: {
          type: 'object',
          properties: { '/': { type: 'string' } },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === 'templates.content_schema.route_schema_non_object_type')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifySchemaDrift
// ---------------------------------------------------------------------------

describe('classifySchemaDrift()', () => {
  it('returns initial_apply when oldSchema is null', () => {
    const result = classifySchemaDrift(null, { type: 'object' });
    expect(result.overall).toBe('safe');
    expect(result.items[0]?.code).toBe('templates.drift.initial_apply');
  });

  it('flags adding an OPTIONAL field as safe', () => {
    const oldS = { type: 'object', properties: { title: { type: 'string' } } };
    const newS = {
      type: 'object',
      properties: { title: { type: 'string' }, subtitle: { type: 'string' } },
    };
    const result = classifySchemaDrift(oldS, newS);
    expect(result.overall).toBe('safe');
    expect(result.items.some((i) => i.code === 'templates.drift.optional_field_added')).toBe(true);
  });

  it('flags adding a REQUIRED field as definitely_breaking', () => {
    const oldS = { type: 'object', properties: { title: { type: 'string' } } };
    const newS = {
      type: 'object',
      properties: { title: { type: 'string' }, subtitle: { type: 'string' } },
      required: ['subtitle'],
    };
    const result = classifySchemaDrift(oldS, newS);
    expect(result.overall).toBe('definitely_breaking');
    expect(result.items.some((i) => i.code === 'templates.drift.required_field_added')).toBe(true);
  });

  it('flags removing a REQUIRED field as definitely_breaking', () => {
    const oldS = {
      type: 'object',
      properties: { title: { type: 'string' }, subtitle: { type: 'string' } },
      required: ['subtitle'],
    };
    const newS = { type: 'object', properties: { title: { type: 'string' } } };
    const result = classifySchemaDrift(oldS, newS);
    expect(result.overall).toBe('definitely_breaking');
    expect(result.items.some((i) => i.code === 'templates.drift.required_field_removed')).toBe(true);
  });

  it('flags removing an OPTIONAL field as potentially_breaking', () => {
    const oldS = {
      type: 'object',
      properties: { title: { type: 'string' }, subtitle: { type: 'string' } },
    };
    const newS = { type: 'object', properties: { title: { type: 'string' } } };
    const result = classifySchemaDrift(oldS, newS);
    expect(result.overall).toBe('potentially_breaking');
    expect(result.items.some((i) => i.code === 'templates.drift.optional_field_removed')).toBe(true);
  });

  it('flags optional → required as definitely_breaking', () => {
    const oldS = { type: 'object', properties: { title: { type: 'string' } } };
    const newS = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const result = classifySchemaDrift(oldS, newS);
    expect(result.overall).toBe('definitely_breaking');
    expect(result.items.some((i) => i.code === 'templates.drift.field_made_required')).toBe(true);
  });

  it('flags type change as definitely_breaking', () => {
    const oldS = { type: 'object', properties: { count: { type: 'number' } } };
    const newS = { type: 'object', properties: { count: { type: 'string' } } };
    const result = classifySchemaDrift(oldS, newS);
    expect(result.overall).toBe('definitely_breaking');
    expect(result.items.some((i) => i.code === 'templates.drift.type_changed')).toBe(true);
  });

  it('flags adding a personalization axis as potentially_breaking', () => {
    const oldS = {
      type: 'object',
      properties: { hero: { type: 'object', 'x-gatewaze-personalize': ['persona'] } },
    };
    const newS = {
      type: 'object',
      properties: { hero: { type: 'object', 'x-gatewaze-personalize': ['persona', 'utm.campaign'] } },
    };
    const result = classifySchemaDrift(oldS, newS);
    expect(result.overall).toBe('potentially_breaking');
    expect(result.items.some((i) => i.code === 'templates.drift.personalization_axis_added')).toBe(true);
  });

  it('flags removing a personalization axis as safe', () => {
    const oldS = {
      type: 'object',
      properties: { hero: { type: 'object', 'x-gatewaze-personalize': ['persona', 'utm.campaign'] } },
    };
    const newS = {
      type: 'object',
      properties: { hero: { type: 'object', 'x-gatewaze-personalize': ['persona'] } },
    };
    const result = classifySchemaDrift(oldS, newS);
    expect(result.overall).toBe('safe');
    expect(result.items.some((i) => i.code === 'templates.drift.personalization_axis_removed')).toBe(true);
  });

  it('recurses into nested object properties', () => {
    const oldS = {
      type: 'object',
      properties: {
        hero: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
    };
    const newS = {
      type: 'object',
      properties: {
        hero: { type: 'object', properties: {} },
      },
    };
    const result = classifySchemaDrift(oldS, newS);
    expect(result.overall).toBe('definitely_breaking');
    expect(result.items.some(
      (i) => i.code === 'templates.drift.required_field_removed' && i.pointer.includes('/properties/hero'),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// walkPersonalizationAxes + appliedAxesForField
// ---------------------------------------------------------------------------

describe('walkPersonalizationAxes()', () => {
  it('extracts axes from top-level field (content-relative pointer)', () => {
    const schema = {
      type: 'object',
      properties: {
        hero: { type: 'object', 'x-gatewaze-personalize': ['persona', 'utm.campaign'] },
      },
    };
    const result = walkPersonalizationAxes(schema);
    expect(result).toEqual([
      // Content-relative pointer: variants in pages_content_variants store
      // field_path against the content document, not against the schema —
      // so /hero is what a variant matches against, not /properties/hero.
      { fieldPointer: '/hero', axes: ['persona', 'utm.campaign'] },
    ]);
  });

  it('returns empty array for a schema with no annotations', () => {
    const schema = {
      type: 'object',
      properties: { footer: { type: 'object', properties: { copyright: { type: 'string' } } } },
    };
    expect(walkPersonalizationAxes(schema)).toEqual([]);
  });

  it('walks nested objects and array items', () => {
    const schema = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', 'x-gatewaze-personalize': ['geo.country'] },
            },
          },
        },
      },
    };
    const result = walkPersonalizationAxes(schema);
    expect(result.length).toBe(1);
    // Content-relative: array items use /items in the path; the property
    // walker descends through `properties` without including the keyword.
    expect(result[0]?.fieldPointer).toBe('/list/items/title');
    expect(result[0]?.axes).toEqual(['geo.country']);
  });
});

describe('appliedAxesForField()', () => {
  it('returns the subset of axes present in BOTH variant.match_context AND request context', () => {
    const result = appliedAxesForField(
      ['persona', 'utm.campaign', 'geo.country'],
      { persona: 'developer', 'utm.campaign': 'mcp-security' },
      { persona: 'developer', 'utm.campaign': 'mcp-security' },
    );
    expect(result).toEqual({ persona: 'developer', 'utm.campaign': 'mcp-security' });
  });

  it('returns empty when no variant was matched', () => {
    const result = appliedAxesForField(
      ['persona'],
      { persona: 'developer' },
      null,
    );
    expect(result).toEqual({});
  });

  it('omits axes that are in the request but NOT in the variant context', () => {
    // The variant matched on persona only; geo.country is in the request
    // but didn't contribute to matching.
    const result = appliedAxesForField(
      ['persona', 'geo.country'],
      { persona: 'developer', 'geo.country': 'US' },
      { persona: 'developer' },
    );
    expect(result).toEqual({ persona: 'developer' });
  });
});
