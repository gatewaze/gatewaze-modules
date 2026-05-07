// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it } from 'vitest';
import { validateContent, validateFieldUpdate } from '../schema-validate.js';

describe('validateContent — types', () => {
  it('accepts a valid object matching the schema', () => {
    const schema = {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 0 },
      },
    };
    expect(validateContent({ title: 'X', count: 3 }, schema).ok).toBe(true);
  });

  it('rejects missing required field', () => {
    const schema = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };
    const r = validateContent({}, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]).toEqual({ jsonPointer: '/title', message: 'required' });
    }
  });

  it('rejects wrong type', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } } };
    const r = validateContent({ title: 42 }, schema);
    expect(r.ok).toBe(false);
  });
});

describe('validateContent — strings', () => {
  it('enforces minLength / maxLength', () => {
    const schema = { type: 'string', minLength: 2, maxLength: 4 };
    expect(validateContent('hi', schema).ok).toBe(true);
    expect(validateContent('h', schema).ok).toBe(false);
    expect(validateContent('hello', schema).ok).toBe(false);
  });

  it('enforces pattern', () => {
    const schema = { type: 'string', pattern: '^[a-z]+$' };
    expect(validateContent('lower', schema).ok).toBe(true);
    expect(validateContent('Upper', schema).ok).toBe(false);
  });

  it('enforces enum', () => {
    const schema = { type: 'string', enum: ['h1', 'h2', 'h3'] };
    expect(validateContent('h2', schema).ok).toBe(true);
    expect(validateContent('h7', schema).ok).toBe(false);
  });
});

describe('validateContent — numbers', () => {
  it('enforces minimum / maximum', () => {
    const schema = { type: 'number', minimum: 0, maximum: 100 };
    expect(validateContent(50, schema).ok).toBe(true);
    expect(validateContent(-1, schema).ok).toBe(false);
    expect(validateContent(101, schema).ok).toBe(false);
  });

  it('enforces integer', () => {
    const schema = { type: 'integer' };
    expect(validateContent(3, schema).ok).toBe(true);
    expect(validateContent(3.5, schema).ok).toBe(false);
  });
});

describe('validateContent — arrays', () => {
  it('validates each item against items schema', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    expect(validateContent(['a', 'b'], schema).ok).toBe(true);
    expect(validateContent(['a', 5], schema).ok).toBe(false);
  });
});

describe('validateContent — complex constructs accepted lenient', () => {
  it('accepts oneOf without validation (leniency)', () => {
    const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateContent('x', schema).ok).toBe(true);
    expect(validateContent({ unrelated: true }, schema).ok).toBe(true);
  });
});

describe('validateFieldUpdate', () => {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 10 },
      image: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'site-media-id' },
          alt: { type: 'string' },
        },
      },
    },
  };

  it('validates a top-level field update', () => {
    expect(validateFieldUpdate('hi', schema, 'title').ok).toBe(true);
    expect(validateFieldUpdate('way too long', schema, 'title').ok).toBe(false);
  });

  it('validates a nested field update', () => {
    expect(validateFieldUpdate('A photo', schema, 'image.alt').ok).toBe(true);
    expect(validateFieldUpdate(42, schema, 'image.alt').ok).toBe(false);
  });

  it('rejects unknown fieldPath', () => {
    const r = validateFieldUpdate('x', schema, 'nonexistent.deep');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0].message).toMatch(/not found/);
    }
  });
});
