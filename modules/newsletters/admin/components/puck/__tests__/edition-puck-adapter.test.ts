// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Edition ↔ PuckData round-trip tests.
 *
 * The adapter is the seam between newsletters' shape (BlockTemplate +
 * EditionBlock with `block_template` link) and Puck's flat
 * `{type, props}` shape. Round-trip must preserve content and ordering;
 * unknown templates must throw.
 */
import { describe, expect, it } from 'vitest';
import { editionToPuckData, puckDataToEdition } from '../edition-puck-adapter.js';
import type { NewsletterEdition, BlockTemplate, BrickTemplate } from '../../../utils/types.js';

const heroTpl: BlockTemplate = {
  id: 'tpl-hero',
  name: 'Hero',
  block_type: 'hero',
  content: { html_template: '<h1>{{headline}}</h1>', schema: {} },
};

const colsTpl: BlockTemplate = {
  id: 'tpl-cols',
  name: 'Two Columns',
  block_type: 'two_columns',
  content: { html_template: '<div>{{>children}}</div>', schema: {}, has_bricks: true },
};

const colTextTpl: BrickTemplate = {
  id: 'btpl-text',
  name: 'Text Column',
  brick_type: 'column_text',
  content: { html_template: '<td>{{body}}</td>', schema: {} },
};

const allBlocks: BlockTemplate[] = [heroTpl, colsTpl];
const allBricks: BrickTemplate[] = [colTextTpl];

// Real UUIDs — `extractStableId` enforces UUID shape now, so fixtures
// can't use ad-hoc strings like 'b-hero' (those would be coerced to a
// fresh UUID at load time, breaking round-trip identity assertions).
const HERO_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const COLS_ID = 'aaaaaaaa-2222-4222-8222-222222222222';
const BRICK1_ID = 'aaaaaaaa-3333-4333-8333-333333333333';
const BRICK2_ID = 'aaaaaaaa-4444-4444-8444-444444444444';

const baseEdition: NewsletterEdition = {
  id: 'ed-1',
  edition_date: '2026-05-08',
  blocks: [
    {
      id: HERO_ID,
      block_template: heroTpl,
      content: { headline: 'Welcome' },
      sort_order: 1000,
      bricks: [],
    },
    {
      id: COLS_ID,
      block_template: colsTpl,
      content: {},
      sort_order: 2000,
      bricks: [
        {
          id: BRICK1_ID,
          brick_template: colTextTpl,
          content: { body: 'Left' },
          sort_order: 1000,
        },
        {
          id: BRICK2_ID,
          brick_template: colTextTpl,
          content: { body: 'Right' },
          sort_order: 2000,
        },
      ],
    },
  ],
};

describe('editionToPuckData', () => {
  it('emits content sorted by sort_order with id + content keys', () => {
    const data = editionToPuckData(baseEdition);
    expect(data.content).toHaveLength(2);
    expect(data.content[0]).toMatchObject({ type: 'hero', props: { id: HERO_ID, headline: 'Welcome' } });
    expect(data.content[1].type).toBe('two_columns');
  });

  it('emits children for has_bricks blocks, sorted', () => {
    const data = editionToPuckData(baseEdition);
    const cols = data.content[1];
    expect(Array.isArray(cols.props.children)).toBe(true);
    expect(cols.props.children).toHaveLength(2);
    expect(cols.props.children![0]).toMatchObject({ type: 'column_text', props: { body: 'Left' } });
    expect(cols.props.children![1].props.body).toBe('Right');
  });

  it('does not emit children when has_bricks is false', () => {
    const data = editionToPuckData(baseEdition);
    expect(data.content[0].props).not.toHaveProperty('children');
  });
});

describe('puckDataToEdition — round-trip', () => {
  it('load + save with no edits preserves the edition shape', () => {
    const data = editionToPuckData(baseEdition);
    const out = puckDataToEdition({
      base: baseEdition,
      data,
      blockTemplates: allBlocks,
      brickTemplates: allBricks,
    });
    expect(out.id).toBe(baseEdition.id);
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[0].id).toBe(HERO_ID);
    expect(out.blocks[0].content).toEqual({ headline: 'Welcome' });
    expect(out.blocks[1].bricks).toHaveLength(2);
    expect(out.blocks[1].bricks[0].content).toEqual({ body: 'Left' });
  });

  it('reorders blocks based on PuckData content order', () => {
    const data = editionToPuckData(baseEdition);
    data.content = [data.content[1], data.content[0]];
    const out = puckDataToEdition({
      base: baseEdition,
      data,
      blockTemplates: allBlocks,
      brickTemplates: allBricks,
    });
    expect(out.blocks[0].block_template.block_type).toBe('two_columns');
    expect(out.blocks[1].block_template.block_type).toBe('hero');
    expect(out.blocks[0].sort_order).toBeLessThan(out.blocks[1].sort_order);
  });

  it('applies content edits and renumbers sort_order', () => {
    const data = editionToPuckData(baseEdition);
    data.content[0].props.headline = 'Welcome back';
    const out = puckDataToEdition({
      base: baseEdition,
      data,
      blockTemplates: allBlocks,
      brickTemplates: allBricks,
    });
    expect(out.blocks[0].content).toEqual({ headline: 'Welcome back' });
  });

  it('inserts a new block — Puck-prefixed id resolves to the embedded UUID', () => {
    // Puck generates ids like `<type>-<uuid>` for new components. The
    // adapter must extract the UUID portion so the DB UUID column accepts
    // it. Per spec-builder-evaluation §3.6 (extended).
    const data = editionToPuckData(baseEdition);
    const NEW_UUID = 'aaaaaaaa-9999-4999-8999-999999999999';
    data.content = [
      ...data.content,
      { type: 'hero', props: { id: `hero-${NEW_UUID}`, headline: 'Inserted' } as any },
    ];
    const out = puckDataToEdition({
      base: baseEdition,
      data,
      blockTemplates: allBlocks,
      brickTemplates: allBricks,
    });
    expect(out.blocks).toHaveLength(3);
    expect(out.blocks[2].id).toBe(NEW_UUID);
    expect(out.blocks[2].block_template.block_type).toBe('hero');
  });

  it('inserts a new block with a non-UUID id — generates a fresh UUID', () => {
    const data = editionToPuckData(baseEdition);
    data.content = [
      ...data.content,
      { type: 'hero', props: { id: 'unstructured-id', headline: 'Inserted' } as any },
    ];
    const out = puckDataToEdition({
      base: baseEdition,
      data,
      blockTemplates: allBlocks,
      brickTemplates: allBricks,
    });
    expect(out.blocks).toHaveLength(3);
    // Adapter coerced the unrecognised id to a fresh UUID.
    expect(out.blocks[2].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(out.blocks[2].id).not.toBe('unstructured-id');
    expect(out.blocks[2].block_template.block_type).toBe('hero');
  });

  it('throws on unknown block_type', () => {
    const data = editionToPuckData(baseEdition);
    data.content[0].type = 'mystery_meat';
    expect(() =>
      puckDataToEdition({ base: baseEdition, data, blockTemplates: allBlocks, brickTemplates: allBricks }),
    ).toThrow(/unknown block_type/);
  });

  it('throws on unknown brick_type', () => {
    const data = editionToPuckData(baseEdition);
    data.content[1].props.children = [{ type: 'forbidden_brick', props: { id: 'tmp' } } as any];
    expect(() =>
      puckDataToEdition({ base: baseEdition, data, blockTemplates: allBlocks, brickTemplates: allBricks }),
    ).toThrow(/unknown brick_type/);
  });
});
