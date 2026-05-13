import { describe, expect, it } from 'vitest';
import {
  walkBlockVariants,
  parseBlockFieldPath,
  type BlockTreeInput,
} from '../walk-block-variants.js';
import type { PageVariantInput } from '../walk-page-variants.js';

const HERO_ID = '11111111-1111-1111-1111-111111111111';
const BLOCK2_ID = '22222222-2222-2222-2222-222222222222';
const BRICK_ID = '33333333-3333-3333-3333-333333333333';

const TREE: BlockTreeInput = {
  topLevel: [
    {
      id: HERO_ID,
      block_def_key: 'hero',
      variant_key: 'default',
      sort_order: 0,
      content: {
        title: 'Welcome',
        cta: { label: 'Sign up', href: '/signup' },
        tags: ['general'],
      },
    },
    {
      id: BLOCK2_ID,
      block_def_key: 'two_columns',
      variant_key: 'default',
      sort_order: 1,
      content: {},
    },
  ],
  bricks: [
    {
      id: BRICK_ID,
      page_block_id: BLOCK2_ID,
      brick_def_key: 'column_text',
      variant_key: 'default',
      sort_order: 0,
      content: { body: 'Default copy' },
    },
  ],
};

function makeVariant(opts: {
  id: string;
  field_path: string;
  match_context: Record<string, unknown>;
  value: unknown;
  priority?: number;
  updated_at?: string;
}): PageVariantInput {
  return {
    id: opts.id,
    field_path: opts.field_path,
    match_context: opts.match_context,
    value: opts.value,
    priority: opts.priority ?? 100,
    updated_at: opts.updated_at ?? '2026-01-01T00:00:00Z',
  };
}

describe('parseBlockFieldPath()', () => {
  it('parses block-id only', () => {
    expect(parseBlockFieldPath(HERO_ID)).toEqual({ instanceId: HERO_ID, propPath: '' });
  });
  it('parses block-id with one prop', () => {
    expect(parseBlockFieldPath(`${HERO_ID}.title`)).toEqual({
      instanceId: HERO_ID,
      propPath: 'title',
    });
  });
  it('parses block-id with nested prop', () => {
    expect(parseBlockFieldPath(`${HERO_ID}.cta.label`)).toEqual({
      instanceId: HERO_ID,
      propPath: 'cta.label',
    });
  });
  it('parses block-id with array index', () => {
    expect(parseBlockFieldPath(`${HERO_ID}.tags[0]`)).toEqual({
      instanceId: HERO_ID,
      propPath: 'tags[0]',
    });
  });
  it('returns null on empty', () => {
    expect(parseBlockFieldPath('')).toBeNull();
  });
});

describe('walkBlockVariants()', () => {
  it('returns tree unchanged when no variants match', () => {
    const variant = makeVariant({
      id: 'v1',
      field_path: `${HERO_ID}.title`,
      match_context: { persona: 'enterprise' },
      value: 'Enterprise welcome',
    });
    const result = walkBlockVariants({ tree: TREE, variants: [variant], context: { persona: 'general' } });
    expect(result.tree.topLevel[0]!.content.title).toBe('Welcome');
    expect(result.applied[variant.field_path]).toBeNull();
    expect(result.overlayed).toBe(0);
  });

  it('overlays a top-level prop when persona matches', () => {
    const variant = makeVariant({
      id: 'v1',
      field_path: `${HERO_ID}.title`,
      match_context: { persona: 'developer' },
      value: 'Build with our API',
    });
    const result = walkBlockVariants({
      tree: TREE,
      variants: [variant],
      context: { persona: 'developer' },
    });
    expect(result.tree.topLevel[0]!.content.title).toBe('Build with our API');
    expect(result.applied[variant.field_path]).toBe('v1');
    expect(result.overlayed).toBe(1);
  });

  it('overlays a nested prop', () => {
    const variant = makeVariant({
      id: 'v1',
      field_path: `${HERO_ID}.cta.label`,
      match_context: { persona: 'enterprise' },
      value: 'Book a demo',
    });
    const result = walkBlockVariants({
      tree: TREE,
      variants: [variant],
      context: { persona: 'enterprise' },
    });
    expect((result.tree.topLevel[0]!.content.cta as { label: string }).label).toBe('Book a demo');
    expect((result.tree.topLevel[0]!.content.cta as { href: string }).href).toBe('/signup');
  });

  it('replaces an array prop wholesale', () => {
    const variant = makeVariant({
      id: 'v1',
      field_path: `${HERO_ID}.tags`,
      match_context: { persona: 'enterprise' },
      value: ['enterprise', 'priority'],
    });
    const result = walkBlockVariants({
      tree: TREE,
      variants: [variant],
      context: { persona: 'enterprise' },
    });
    expect(result.tree.topLevel[0]!.content.tags).toEqual(['enterprise', 'priority']);
  });

  it('overlays a brick prop', () => {
    const variant = makeVariant({
      id: 'v1',
      field_path: `${BRICK_ID}.body`,
      match_context: { persona: 'developer' },
      value: 'Developer-specific column copy',
    });
    const result = walkBlockVariants({
      tree: TREE,
      variants: [variant],
      context: { persona: 'developer' },
    });
    expect(result.tree.bricks[0]!.content.body).toBe('Developer-specific column copy');
  });

  it('warns when block id no longer exists', () => {
    const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const variant = makeVariant({
      id: 'v1',
      field_path: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.title',
      match_context: {},
      value: 'orphaned',
    });
    const result = walkBlockVariants({
      tree: TREE,
      variants: [variant],
      context: {},
      onWarning: (msg, meta) => warnings.push({ msg, meta }),
    });
    expect(warnings[0]?.msg).toBe('walkBlockVariants.instance_not_found');
    expect(result.applied[variant.field_path]).toBeNull();
  });

  it('multi-axis variant beats persona-only', () => {
    const variantA = makeVariant({
      id: 'va',
      field_path: `${HERO_ID}.title`,
      match_context: { persona: 'enterprise' },
      value: 'Enterprise A',
    });
    const variantB = makeVariant({
      id: 'vb',
      field_path: `${HERO_ID}.title`,
      match_context: { persona: 'enterprise', 'utm.campaign': 'q1' },
      value: 'Enterprise Q1',
    });
    const result = walkBlockVariants({
      tree: TREE,
      variants: [variantA, variantB],
      context: { persona: 'enterprise', 'utm.campaign': 'q1' },
    });
    expect(result.tree.topLevel[0]!.content.title).toBe('Enterprise Q1');
    expect(result.applied[variantA.field_path]).toBe('vb');
  });

  it('does not mutate the input tree', () => {
    const before = JSON.stringify(TREE);
    walkBlockVariants({
      tree: TREE,
      variants: [
        makeVariant({
          id: 'v1',
          field_path: `${HERO_ID}.title`,
          match_context: { persona: 'developer' },
          value: 'mutated',
        }),
      ],
      context: { persona: 'developer' },
    });
    expect(JSON.stringify(TREE)).toBe(before);
  });
});
