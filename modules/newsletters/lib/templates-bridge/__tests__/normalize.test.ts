import { describe, expect, it } from 'vitest';
import {
  normalizeFromTemplatesBlockDef,
  normalizeFromTemplatesBrickDef,
  normalizeLegacyBlockTemplates,
  normalizeLegacyBrickTemplates,
} from '../normalize.js';

describe('normalizeFromTemplatesBlockDef()', () => {
  it('shapes a templates_block_defs row into the bridge type', () => {
    const r = normalizeFromTemplatesBlockDef({
      id: 'bd-1', library_id: 'lib-1', key: 'header',
      name: 'Header', description: 'Top of newsletter',
      schema: { type: 'object' }, html: '<header/>',
      rich_text_template: '*Header*', has_bricks: false,
    });
    expect(r).toEqual({
      id: 'bd-1', library_id: 'lib-1', key: 'header',
      name: 'Header', description: 'Top of newsletter',
      schema: { type: 'object' }, html: '<header/>',
      rich_text_template: '*Header*', has_bricks: false,
      source: 'templates_block_defs',
    });
  });

  it('coerces nullable html to empty string', () => {
    const r = normalizeFromTemplatesBlockDef({
      id: 'bd-1', library_id: 'l', key: 'k', name: 'n', description: null,
      schema: {}, html: null, rich_text_template: null, has_bricks: false,
    });
    expect(r.html).toBe('');
  });

  it('defaults schema to {} when row.schema is non-object', () => {
    const r = normalizeFromTemplatesBlockDef({
      id: 'bd-1', library_id: 'l', key: 'k', name: 'n', description: null,
      schema: 'not an object' as unknown,
      html: '', rich_text_template: null, has_bricks: false,
    });
    expect(r.schema).toEqual({});
  });
});

describe('normalizeLegacyBlockTemplates()', () => {
  it('collates html_template + rich-text variants per (collection, block_type)', () => {
    const rows = [
      {
        id: 'a', collection_id: 'c1', block_type: 'header', name: 'Header', description: null,
        content: { html_template: '<header>HTML</header>', schema: { type: 'object' }, has_bricks: false },
        variant_key: 'html_template',
      },
      {
        id: 'b', collection_id: 'c1', block_type: 'header', name: 'Header', description: null,
        content: { template: '*Header markdown*' },
        variant_key: 'substack',
      },
    ];
    const out = normalizeLegacyBlockTemplates(rows);
    expect(out).toHaveLength(1);
    const def = out[0]!;
    expect(def.id).toBe('a');                   // legacy html_template id
    expect(def.html).toBe('<header>HTML</header>');
    expect(def.rich_text_template).toBe('*Header markdown*');
    expect(def.schema).toEqual({ type: 'object' });
    expect(def.source).toBe('legacy');
  });

  it('skips groups with no html_template variant (editor cannot render)', () => {
    const rows = [{
      id: 'a', collection_id: 'c1', block_type: 'orphan', name: 'Orphan', description: null,
      content: { template: '*only rich text*' },
      variant_key: 'substack',
    }];
    expect(normalizeLegacyBlockTemplates(rows)).toEqual([]);
  });

  it('handles multiple block types in one collection', () => {
    const rows = [
      { id: 'a', collection_id: 'c1', block_type: 'header', name: 'Header', description: null, content: { html_template: 'H' }, variant_key: 'html_template' },
      { id: 'b', collection_id: 'c1', block_type: 'footer', name: 'Footer', description: null, content: { html_template: 'F' }, variant_key: 'html_template' },
    ];
    const out = normalizeLegacyBlockTemplates(rows);
    expect(out.map((d) => d.key).sort()).toEqual(['footer', 'header']);
  });

  it('alphabetically picks the rich-text variant when multiple exist (deterministic)', () => {
    const rows = [
      { id: 'h', collection_id: 'c1', block_type: 'x', name: 'X', description: null, content: { html_template: 'HTML' }, variant_key: 'html_template' },
      { id: 's', collection_id: 'c1', block_type: 'x', name: 'X', description: null, content: { template: 'BEEHIIV' }, variant_key: 'beehiiv' },
      { id: 't', collection_id: 'c1', block_type: 'x', name: 'X', description: null, content: { template: 'SUBSTACK' }, variant_key: 'substack' },
    ];
    const def = normalizeLegacyBlockTemplates(rows)[0]!;
    expect(def.rich_text_template).toBe('BEEHIIV'); // 'beehiiv' < 'substack' alphabetically
  });
});

describe('normalizeLegacyBrickTemplates()', () => {
  it('collates html + rich variants per (parent block, brick_type)', () => {
    const rows = [
      { id: 'a', block_template_id: 'p1', brick_type: 'item', name: 'Item', content: { html_template: '<li/>', schema: {} }, variant_key: 'html_template', sort_order: 0 },
      { id: 'b', block_template_id: 'p1', brick_type: 'item', name: 'Item', content: { template: '* item' }, variant_key: 'substack', sort_order: 0 },
    ];
    const out = normalizeLegacyBrickTemplates(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.html).toBe('<li/>');
    expect(out[0]?.rich_text_template).toBe('* item');
  });

  it('skips bricks without a parent block_template_id', () => {
    const rows = [{
      id: 'a', block_template_id: null, brick_type: 'orphan', name: 'O',
      content: { html_template: '<x/>' }, variant_key: 'html_template', sort_order: 0,
    }];
    expect(normalizeLegacyBrickTemplates(rows)).toEqual([]);
  });
});

describe('normalizeFromTemplatesBrickDef()', () => {
  it('shapes a templates_brick_defs row', () => {
    const r = normalizeFromTemplatesBrickDef({
      id: 'br-1', block_def_id: 'bd-1', key: 'item', name: 'Item',
      schema: {}, html: '<li/>', rich_text_template: null, sort_order: 5,
    });
    expect(r.id).toBe('br-1');
    expect(r.block_def_id).toBe('bd-1');
    expect(r.sort_order).toBe(5);
    expect(r.source).toBe('templates_brick_defs');
  });
});
