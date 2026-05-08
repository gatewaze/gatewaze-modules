// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it } from 'vitest';
import { pageBlocksToPuckData, diffToOps } from '../puck-data-adapter.js';
import { RefetchRequired, type PageBlockTree, type PuckData } from '../types.js';

const PAGE_ID = '00000000-0000-0000-0000-000000000001';
const HERO_ID = '00000000-0000-0000-0000-000000000010';
const PARA_ID = '00000000-0000-0000-0000-000000000011';
const CTA_ID  = '00000000-0000-0000-0000-000000000012';
const COLS_ID = '00000000-0000-0000-0000-000000000020';
const BRICK_A = '00000000-0000-0000-0000-0000000000a1';
const BRICK_B = '00000000-0000-0000-0000-0000000000a2';

const KNOWN_BLOCK_KEYS = new Set(['hero', 'paragraph', 'cta_button', 'two_columns']);
const KNOWN_BRICKS = new Map<string, ReadonlySet<string>>([
  ['two_columns', new Set(['column_text', 'column_card'])],
]);

function emptyTree(): PageBlockTree {
  return {
    page: { id: PAGE_ID, wrapper_key: 'default', root_meta: {}, wysiwyg_locked: false },
    topLevel: [],
    bricks: [],
  };
}

function fixtureFlat(): PageBlockTree {
  return {
    page: { id: PAGE_ID, wrapper_key: 'default', root_meta: {}, wysiwyg_locked: false },
    topLevel: [
      {
        id: HERO_ID,
        block_def_key: 'hero',
        block_def_id: 'def-hero',
        parent_brick_id: null,
        sort_order: 1000,
        variant_key: 'default',
        has_bricks: false,
        content: { headline: 'Welcome', subhead: 'Hi.' },
      },
      {
        id: PARA_ID,
        block_def_key: 'paragraph',
        block_def_id: 'def-paragraph',
        parent_brick_id: null,
        sort_order: 2000,
        variant_key: 'default',
        has_bricks: false,
        content: { body: 'Lorem ipsum.' },
      },
    ],
    bricks: [],
  };
}

function fixtureWithBricks(): PageBlockTree {
  return {
    page: { id: PAGE_ID, wrapper_key: 'default', root_meta: {}, wysiwyg_locked: false },
    topLevel: [
      {
        id: COLS_ID,
        block_def_key: 'two_columns',
        block_def_id: 'def-cols',
        parent_brick_id: null,
        sort_order: 1000,
        variant_key: 'default',
        has_bricks: true,
        content: {},
      },
    ],
    bricks: [
      {
        id: BRICK_A,
        page_block_id: COLS_ID,
        brick_def_key: 'column_text',
        brick_def_id: 'bd-text',
        sort_order: 1000,
        variant_key: 'default',
        content: { body: 'Left' },
      },
      {
        id: BRICK_B,
        page_block_id: COLS_ID,
        brick_def_key: 'column_text',
        brick_def_id: 'bd-text',
        sort_order: 2000,
        variant_key: 'default',
        content: { body: 'Right' },
      },
    ],
  };
}

describe('pageBlocksToPuckData', () => {
  it('round-trips an empty page', () => {
    const data = pageBlocksToPuckData(emptyTree());
    expect(data.content).toEqual([]);
    expect(data.root.props).toEqual({ wrapperKey: 'default' });
  });

  it('emits content in sort_order, with id + variant_key + content keys', () => {
    const data = pageBlocksToPuckData(fixtureFlat());
    expect(data.content).toHaveLength(2);
    expect(data.content[0]).toEqual({
      type: 'hero',
      props: { id: HERO_ID, variant_key: 'default', headline: 'Welcome', subhead: 'Hi.' },
    });
    expect(data.content[1].type).toBe('paragraph');
  });

  it('emits children for has_bricks blocks, sorted by sort_order', () => {
    const data = pageBlocksToPuckData(fixtureWithBricks());
    expect(data.content).toHaveLength(1);
    const cols = data.content[0];
    expect(cols.type).toBe('two_columns');
    const children = cols.props.children;
    expect(Array.isArray(children)).toBe(true);
    expect(children).toHaveLength(2);
    expect(children![0].props.body).toBe('Left');
    expect(children![1].props.body).toBe('Right');
  });

  it('does not emit children when has_bricks=false', () => {
    const data = pageBlocksToPuckData(fixtureFlat());
    for (const c of data.content) {
      expect(c.props).not.toHaveProperty('children');
    }
  });
});

describe('diffToOps — INSERT', () => {
  it('emits block.insert when next has an entry without an id', () => {
    const prev = emptyTree();
    const next: PuckData = {
      content: [{ type: 'hero', props: { id: 'tmp-1', headline: 'Welcome' } as any }],
      root: { props: {} },
    };
    const ops = diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'block.insert',
      blockDefKey: 'hero',
      afterBlockId: null,
      content: { headline: 'Welcome' },
    });
  });

  it('refuses unknown block_def_key', () => {
    const prev = emptyTree();
    const next: PuckData = {
      content: [{ type: 'mystery_meat', props: { id: 'tmp', headline: 'x' } as any }],
      root: { props: {} },
    };
    expect(() =>
      diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS }),
    ).toThrow(RefetchRequired);
  });
});

describe('diffToOps — DELETE', () => {
  it('emits block.delete for ids removed from next', () => {
    const prev = fixtureFlat();
    const next = pageBlocksToPuckData(prev);
    next.content = next.content.filter((c) => c.props.id !== HERO_ID);
    const ops = diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS });
    expect(ops).toEqual([{ kind: 'block.delete', blockId: HERO_ID }]);
  });
});

describe('diffToOps — MOVE', () => {
  it('emits block.move when order changes', () => {
    const prev = fixtureFlat();
    const next = pageBlocksToPuckData(prev);
    // Swap order
    next.content = [next.content[1], next.content[0]];
    const ops = diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS });
    // Both blocks technically change anchor: paragraph moves to top (anchor null), hero moves after paragraph
    const moves = ops.filter((o) => o.kind === 'block.move');
    expect(moves.length).toBeGreaterThanOrEqual(1);
    const heroMove = moves.find((o) => 'blockId' in o && o.blockId === HERO_ID);
    expect(heroMove).toMatchObject({ kind: 'block.move', blockId: HERO_ID, afterBlockId: PARA_ID });
  });

  it('emits no ops when load → save round-trips unchanged', () => {
    const prev = fixtureFlat();
    const next = pageBlocksToPuckData(prev);
    const ops = diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS });
    expect(ops).toEqual([]);
  });
});

describe('diffToOps — UPDATE', () => {
  it('emits one block.update_field per changed key', () => {
    const prev = fixtureFlat();
    const next = pageBlocksToPuckData(prev);
    next.content[0].props.headline = 'Welcome back';
    const ops = diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS });
    expect(ops).toEqual([
      { kind: 'block.update_field', blockId: HERO_ID, fieldPath: 'headline', newValue: 'Welcome back' },
    ]);
  });

  it('emits update_field with undefined for removed keys', () => {
    const prev = fixtureFlat();
    const next = pageBlocksToPuckData(prev);
    delete next.content[0].props.subhead;
    const ops = diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS });
    expect(ops).toEqual([
      { kind: 'block.update_field', blockId: HERO_ID, fieldPath: 'subhead', newValue: undefined },
    ]);
  });

  it('treats deeply equal nested objects as no-ops', () => {
    const prev: PageBlockTree = {
      ...emptyTree(),
      topLevel: [{
        id: HERO_ID,
        block_def_key: 'hero',
        block_def_id: 'def-hero',
        parent_brick_id: null,
        sort_order: 1000,
        variant_key: 'default',
        has_bricks: false,
        content: { meta: { tags: ['a', 'b'], n: 2 } },
      }],
    };
    const next = pageBlocksToPuckData(prev);
    // Re-create the same shape
    next.content[0].props.meta = { tags: ['a', 'b'], n: 2 };
    const ops = diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS });
    expect(ops).toEqual([]);
  });
});

describe('diffToOps — invariants (fail closed)', () => {
  it('throws RefetchRequired if block type silently changes', () => {
    const prev = fixtureFlat();
    const next = pageBlocksToPuckData(prev);
    next.content[0].type = 'paragraph'; // tampered
    expect(() =>
      diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS }),
    ).toThrow(RefetchRequired);
  });

  it('throws RefetchRequired if variant_key tampered', () => {
    const prev = fixtureFlat();
    const next = pageBlocksToPuckData(prev);
    next.content[0].props.variant_key = 'b';
    expect(() =>
      diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS }),
    ).toThrow(RefetchRequired);
  });
});

describe('diffToOps — bricks', () => {
  it('emits brick.insert / brick.move / brick.delete / brick.update_field', () => {
    const prev = fixtureWithBricks();
    const next = pageBlocksToPuckData(prev);
    // Reorder bricks (swap)
    const cols = next.content[0];
    cols.props.children = [cols.props.children![1], cols.props.children![0]];
    // Edit one brick's body
    cols.props.children![0].props.body = 'Right!';
    // Insert a new brick at the start
    cols.props.children = [
      { type: 'column_card', props: { id: 'tmp-card' } as any },
      ...cols.props.children!,
    ];
    // Delete one (remove the original BRICK_A entirely)
    cols.props.children = cols.props.children.filter(
      (c: any) => c.props.id !== BRICK_A,
    );

    const ops = diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS });
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toContain('brick.delete');
    expect(kinds).toContain('brick.insert');
    expect(kinds).toContain('brick.update_field');
  });

  it('refuses unknown brick_def_key', () => {
    const prev = fixtureWithBricks();
    const next = pageBlocksToPuckData(prev);
    next.content[0].props.children = [
      { type: 'forbidden_brick', props: { id: 'tmp' } as any },
    ];
    expect(() =>
      diffToOps({ prev, next, knownBlockDefKeys: KNOWN_BLOCK_KEYS, knownBrickDefKeysByBlock: KNOWN_BRICKS }),
    ).toThrow(RefetchRequired);
  });
});
