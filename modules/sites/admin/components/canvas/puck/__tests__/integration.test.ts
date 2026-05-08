// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Integration test for the Puck adapter pipeline:
 *
 *   block_defs + brick_defs + page_blocks tree
 *      → buildPuckConfig (Config)
 *      → pageBlocksToPuckData (PuckData baseline)
 *      → user edits applied to PuckData
 *      → diffToOps → CanvasOp[] stream
 *
 * The end-to-end happy path is what unblocks Phase B mounting in the
 * admin app. Specific edge cases live in puck-data-adapter.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildPuckConfig } from '../PuckConfigAdapter.js';
import { pageBlocksToPuckData, diffToOps } from '../puck-data-adapter.js';
import type {
  BlockDefRow,
  BrickDefRow,
  WrapperRow,
  PageBlockTree,
  PuckRenderHost,
} from '../types.js';

const renderHost: PuckRenderHost = {
  renderBlock: () => null as never,
  showMediaPicker: () => undefined,
};

const wrappers: WrapperRow[] = [
  { id: 'w-default', key: 'default', is_current: true, schema: {} },
];

const blockDefs: BlockDefRow[] = [
  {
    id: 'def-hero', key: 'hero', name: 'Hero',
    has_bricks: false, is_current: true, theme_kind: 'website', html: '<h1>{{headline}}</h1>',
    schema: {
      type: 'object',
      properties: {
        headline: { type: 'string', title: 'Headline', default: 'Welcome' },
        body: { type: 'string', format: 'richtext', title: 'Body' },
        bg: { type: 'string', format: 'image', title: 'Background' },
      },
    },
  },
  {
    id: 'def-cols', key: 'two_columns', name: 'Two Columns',
    has_bricks: true, is_current: true, theme_kind: 'website', html: '<div class="cols">{{>children}}</div>',
    schema: {
      type: 'object',
      properties: { gap: { type: 'integer', default: 16 } },
    },
  },
];

const brickDefs: BrickDefRow[] = [
  {
    id: 'bd-text', key: 'column_text', name: 'Text',
    parent_block_def_key: 'two_columns', parent_block_def_id: 'def-cols',
    is_current: true, theme_kind: 'website', html: '<div>{{body}}</div>',
    schema: { type: 'object', properties: { body: { type: 'string', format: 'textarea' } } },
  },
];

describe('Puck adapter — integration', () => {
  it('builds a config that exposes every current block and brick', () => {
    const result = buildPuckConfig({
      libraryId: 'lib-a',
      blockDefs, brickDefs, wrappers,
      themeKind: 'website',
      renderHost,
    });
    expect(Object.keys(result.config.components)).toEqual(
      expect.arrayContaining(['hero', 'two_columns', 'column_text']),
    );
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // Custom-format fields are present and tagged.
    const heroFields = (result.config.components.hero as { fields: Record<string, { type: string; customFormat?: string }> }).fields;
    expect(heroFields.body.type).toBe('custom');
    expect(heroFields.body.customFormat).toBe('richtext');
    expect(heroFields.bg.type).toBe('custom');
    expect(heroFields.bg.customFormat).toBe('image');
  });

  it('round-trips a tree through load + diff with no user edits → 0 ops', () => {
    const tree: PageBlockTree = {
      page: { id: 'p1', wrapper_key: 'default', root_meta: {}, wysiwyg_locked: false },
      topLevel: [
        { id: 'b1', block_def_key: 'hero', block_def_id: 'def-hero',
          parent_brick_id: null, sort_order: 1000, variant_key: 'default',
          has_bricks: false, content: { headline: 'Hello', body: '<p>x</p>' } },
        { id: 'b2', block_def_key: 'two_columns', block_def_id: 'def-cols',
          parent_brick_id: null, sort_order: 2000, variant_key: 'default',
          has_bricks: true, content: { gap: 16 } },
      ],
      bricks: [
        { id: 'br1', page_block_id: 'b2', brick_def_key: 'column_text', brick_def_id: 'bd-text',
          sort_order: 1000, variant_key: 'default', content: { body: 'Left' } },
      ],
    };
    const data = pageBlocksToPuckData(tree);
    const ops = diffToOps({
      prev: tree, next: data,
      knownBlockDefKeys: new Set(['hero', 'two_columns']),
      knownBrickDefKeysByBlock: new Map([['two_columns', new Set(['column_text'])]]),
    });
    expect(ops).toEqual([]);
  });

  it('produces correct op stream for a realistic edit session', () => {
    const tree: PageBlockTree = {
      page: { id: 'p1', wrapper_key: 'default', root_meta: {}, wysiwyg_locked: false },
      topLevel: [
        { id: 'b1', block_def_key: 'hero', block_def_id: 'def-hero',
          parent_brick_id: null, sort_order: 1000, variant_key: 'default',
          has_bricks: false, content: { headline: 'Welcome' } },
      ],
      bricks: [],
    };
    const data = pageBlocksToPuckData(tree);
    // User edits headline, then drops a new two_columns block at the end.
    data.content[0].props.headline = 'Welcome back';
    data.content = [
      ...data.content,
      { type: 'two_columns', props: { id: 'tmp-cols', gap: 24 } as any },
    ];
    const ops = diffToOps({
      prev: tree, next: data,
      knownBlockDefKeys: new Set(['hero', 'two_columns']),
      knownBrickDefKeysByBlock: new Map([['two_columns', new Set(['column_text'])]]),
    });
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toContain('block.update_field');
    expect(kinds).toContain('block.insert');
    expect(kinds.filter((k) => k === 'block.update_field')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'block.insert')).toHaveLength(1);
  });
});
