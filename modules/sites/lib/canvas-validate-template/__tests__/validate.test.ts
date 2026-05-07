// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it } from 'vitest';
import { validateCanvasTemplate } from '../index.js';

const HERO_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string', format: 'html' },
    image: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'site-media-id' },
        alt: { type: 'string' },
      },
    },
  },
};

describe('validateCanvasTemplate — happy path', () => {
  it('accepts a well-formed hero block_def', () => {
    const html = `<section data-block-root class="hero">
      <h1 data-field="title" data-edit="plain">{{title}}</h1>
      <div data-field="body" data-edit="rich-text">{{{body}}}</div>
      <img data-asset="image.id" src="{{image.url}}" alt="{{image.alt}}">
    </section>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(true);
  });

  it('accepts a container block with brick slots', () => {
    const html = `<div data-block-root class="row">
      <div data-children="left">{{>left}}</div>
      <div data-children="right">{{>right}}</div>
    </div>`;
    const r = validateCanvasTemplate({
      html,
      schema: { type: 'object', properties: {} },
      brickDefKeys: ['left', 'right'],
    });
    expect(r.valid).toBe(true);
  });
});

describe('validateCanvasTemplate — block_root rules', () => {
  it('rejects template with no data-block-root', () => {
    const html = `<div><h1 data-field="title">{{title}}</h1></div>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors[0].code).toBe('canvas.template.no_block_root');
    }
  });

  it('rejects template with multiple data-block-root', () => {
    const html = `<section data-block-root>X</section><section data-block-root>Y</section>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      const codes = r.errors.map((e) => e.code);
      expect(codes).toContain('canvas.template.multiple_block_roots');
    }
  });
});

describe('validateCanvasTemplate — data-field path resolution', () => {
  it('rejects unknown field path', () => {
    const html = `<section data-block-root><span data-field="missing">{{missing}}</span></section>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      const codes = r.errors.map((e) => e.code);
      expect(codes).toContain('canvas.template.field_path_unresolved');
    }
  });

  it('rejects rich-text on void element', () => {
    const html = `<section data-block-root>
      <img data-field="title" data-edit="rich-text" src="">
    </section>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      const codes = r.errors.map((e) => e.code);
      expect(codes).toContain('canvas.template.rich_text_void_element');
    }
  });
});

describe('validateCanvasTemplate — data-children rules', () => {
  it('rejects unknown brick key', () => {
    const html = `<div data-block-root><div data-children="unknown">{{>unknown}}</div></div>`;
    const r = validateCanvasTemplate({
      html, schema: { type: 'object' }, brickDefKeys: ['left', 'right'],
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.find((e) => e.code === 'canvas.template.children_unknown_brick')).toBeDefined();
    }
  });
});

describe('validateCanvasTemplate — data-asset rules', () => {
  it('rejects asset path that does not resolve', () => {
    const html = `<section data-block-root><img data-asset="not.there" src=""></section>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.find((e) => e.code === 'canvas.template.asset_path_unresolved')).toBeDefined();
    }
  });

  it('rejects asset on field without site-media-id format', () => {
    const html = `<section data-block-root><img data-asset="title" src=""></section>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      const e = r.errors.find((e) => e.code === 'canvas.template.asset_path_unresolved');
      expect(e?.message).toMatch(/site-media-id/);
    }
  });
});

describe('validateCanvasTemplate — {{{x}}} substitution rules', () => {
  it('rejects {{{x}}} on non-html field', () => {
    const html = `<section data-block-root><div data-field="title" data-edit="rich-text">{{{title}}}</div></section>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.find((e) => e.code === 'canvas.template.unsafe_substitution')).toBeDefined();
    }
  });

  it('accepts {{{x}}} on html-formatted field', () => {
    const html = `<section data-block-root><div data-field="body" data-edit="rich-text">{{{body}}}</div></section>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(true);
  });

  it('rejects trusted-html field missing x-edit-role', () => {
    const schema = {
      type: 'object',
      properties: {
        embed: { type: 'string', format: 'trusted-html' },
      },
    };
    const html = `<section data-block-root><div data-field="embed" data-edit="rich-text">{{{embed}}}</div></section>`;
    const r = validateCanvasTemplate({ html, schema, brickDefKeys: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      const codes = r.errors.map((e) => e.code);
      expect(codes).toContain('canvas.template.trusted_html_missing_role');
    }
  });

  it('accepts trusted-html field with x-edit-role: super_admin', () => {
    const schema = {
      type: 'object',
      properties: {
        embed: { type: 'string', format: 'trusted-html', 'x-edit-role': 'super_admin' },
      },
    };
    const html = `<section data-block-root><div data-field="embed" data-edit="rich-text">{{{embed}}}</div></section>`;
    const r = validateCanvasTemplate({ html, schema, brickDefKeys: [] });
    expect(r.valid).toBe(true);
  });
});

describe('validateCanvasTemplate — script tag forbidden', () => {
  it('rejects raw <script> in the template', () => {
    const html = `<section data-block-root><script>alert(1)</script></section>`;
    const r = validateCanvasTemplate({ html, schema: HERO_SCHEMA, brickDefKeys: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.find((e) => e.code === 'canvas.template.script_tag_forbidden')).toBeDefined();
    }
  });
});
