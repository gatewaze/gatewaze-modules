import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { coerceBlockSchema } from '../lib/coerce-block-schema.js';

/** Compiling with ajv throws on an invalid `type` — a proxy for the
 *  draft-2020-12 validity Anthropic's tool validator enforces. */
function assertCompiles(schema: Record<string, unknown>): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  expect(() => ajv.compile(schema)).not.toThrow();
}

describe('coerceBlockSchema — Puck field-map encoding (DB templates)', () => {
  it('converts a richtext/text field map into an object schema', () => {
    const out = coerceBlockSchema({
      body: { type: 'richtext', label: 'Body' },
      title: { type: 'text', label: 'Title' },
    });
    expect(out).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        body: { type: 'string', format: 'richtext' },
        title: { type: 'string' },
      },
    });
    assertCompiles(out);
  });

  it('maps an image field to a string with format=image', () => {
    const out = coerceBlockSchema({ image_url: { type: 'image', label: 'Meme image' } });
    expect((out.properties as any).image_url).toEqual({ type: 'string', format: 'image' });
    assertCompiles(out);
  });

  it('converts array fields (with nested `fields`) into array-of-object', () => {
    const out = coerceBlockSchema({
      jobs: {
        type: 'array',
        label: 'Jobs',
        fields: {
          company: { type: 'text' },
          description: { type: 'richtext' },
        },
      },
      header_title: { type: 'text', label: 'Header' },
    });
    expect((out.properties as any).jobs).toEqual({
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          company: { type: 'string' },
          description: { type: 'string', format: 'richtext' },
        },
      },
    });
    assertCompiles(out);
  });

  it('omits slot fields (children are user drag-and-drop, not AI-generated)', () => {
    const out = coerceBlockSchema({ children: { type: 'slot', label: 'Bricks' } });
    expect(out).toEqual({ type: 'object', additionalProperties: false, properties: {} });
    assertCompiles(out);
  });

  it('derives an enum from select/radio options', () => {
    const out = coerceBlockSchema({
      align: { type: 'select', options: [{ value: 'left' }, { value: 'right' }] },
    });
    expect((out.properties as any).align).toEqual({ type: 'string', enum: ['left', 'right'] });
    assertCompiles(out);
  });
});

describe('coerceBlockSchema — already-valid JSON Schema (registry / newer templates)', () => {
  it('passes a valid object schema through structurally unchanged', () => {
    const valid = {
      type: 'object',
      additionalProperties: false,
      properties: {
        section_title: { type: 'string', title: 'Section Title' },
        ai_body: { type: 'string', format: 'ai_content' },
        count: { type: 'number' },
      },
      required: ['section_title'],
    };
    const out = coerceBlockSchema(valid);
    expect(out).toEqual(valid);
    assertCompiles(out);
  });

  it('fixes an invalid nested `type` inside an otherwise-valid schema', () => {
    const out = coerceBlockSchema({
      type: 'object',
      properties: { body: { type: 'richtext' } },
    });
    expect((out.properties as any).body).toEqual({ type: 'string', format: 'richtext' });
    assertCompiles(out);
  });

  it('handles an empty schema', () => {
    const out = coerceBlockSchema({});
    expect(out).toEqual({ type: 'object', additionalProperties: false, properties: {} });
    assertCompiles(out);
  });
});
