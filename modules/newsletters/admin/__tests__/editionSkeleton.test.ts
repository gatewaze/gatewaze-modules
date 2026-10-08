import { describe, expect, it } from 'vitest';
import { asEditionSkeleton, buildSkeletonBlocks, type SkeletonBlockDef } from '../lib/editionSkeleton.js';

const def = (key: string, over: Partial<SkeletonBlockDef> = {}): SkeletonBlockDef => ({
  id: `def-${key}`,
  key,
  name: key.replace(/_/g, ' '),
  schema: { eyebrow: { type: 'text' } },
  html: `<Section>{{eyebrow}}</Section>`,
  render_kind: 'declarative',
  ...over,
});

describe('asEditionSkeleton', () => {
  it('accepts the stored shape and string shorthand, dropping junk entries', () => {
    expect(asEditionSkeleton({ version: 1, blocks: [{ key: 'a' }, 'b', { key: 'c', content: { x: 1 } }, { nope: true }, 4] })).toEqual({
      version: 1,
      blocks: [{ key: 'a' }, { key: 'b' }, { key: 'c', content: { x: 1 } }],
    });
  });

  it('re-applies the ingest rules: bad keys are dropped, unsafe content is stripped, the list is capped', () => {
    const polluted = JSON.parse('{"__proto__": {"owned": true}}');
    const s = asEditionSkeleton({
      blocks: [
        { key: 'Bad Key' },
        { key: '../x' },
        { key: 'ok', content: polluted },
        { key: 'ok2', content: { eyebrow: 'FUNDING', nested: { fn: 1 } } },
        { key: 'ok3', content: 'not an object' },
        ...Array.from({ length: 60 }, (_, i) => `b${i}`),
      ],
    });
    expect(s?.blocks.slice(0, 3)).toEqual([{ key: 'ok' }, { key: 'ok2', content: { eyebrow: 'FUNDING', nested: { fn: 1 } } }, { key: 'ok3' }]);
    expect(s?.blocks.length).toBe(50 - 2);
    expect(Object.prototype.hasOwnProperty.call({}, 'owned')).toBe(false);
  });

  it('is null for null, non-objects and empty lists', () => {
    expect(asEditionSkeleton(null)).toBeNull();
    expect(asEditionSkeleton('x')).toBeNull();
    expect(asEditionSkeleton({ blocks: [] })).toBeNull();
    expect(asEditionSkeleton({ blocks: [{ content: {} }] })).toBeNull();
  });
});

describe('buildSkeletonBlocks', () => {
  const defs = [def('lead_commentary'), def('top_stories'), def('aaif_news')];
  let n = 0;
  const newId = () => `id-${++n}`;

  it('seeds one editor block per key, in order, with schema defaults under skeleton content', () => {
    n = 0;
    const { blocks, missing } = buildSkeletonBlocks({
      skeleton: { blocks: [{ key: 'lead_commentary' }, { key: 'top_stories', content: { eyebrow: 'THIS WEEK' } }] },
      defs,
      defaultsFor: (key) => ({ eyebrow: key.toUpperCase(), items: [] }),
      newId,
    });
    expect(missing).toEqual([]);
    expect(blocks.map((b) => [b.id, b.block_template.block_type, b.block_template.id, b.sort_order, b.content])).toEqual([
      ['id-1', 'lead_commentary', 'def-lead_commentary', 1000, { eyebrow: 'LEAD_COMMENTARY', items: [] }],
      ['id-2', 'top_stories', 'def-top_stories', 2000, { eyebrow: 'THIS WEEK', items: [] }],
    ]);
    // The editor's BlockTemplate shape (what the palette produces) is matched exactly.
    expect(blocks[0].block_template.content).toEqual({ html_template: '<Section>{{eyebrow}}</Section>', rich_text_template: null, has_bricks: false, schema: { eyebrow: { type: 'text' } } });
    expect(blocks[0].bricks).toEqual([]);
  });

  it('skips keys the library does not have and reports them once, keeping sort order dense', () => {
    n = 0;
    const { blocks, missing } = buildSkeletonBlocks({
      skeleton: { blocks: [{ key: 'ghost' }, { key: 'aaif_news' }, { key: 'ghost' }] },
      defs,
      defaultsFor: () => ({}),
      newId,
    });
    expect(missing).toEqual(['ghost']);
    expect(blocks.map((b) => [b.block_template.block_type, b.sort_order])).toEqual([['aaif_news', 1000]]);
  });

  it('allows the same block more than once (two generic sections)', () => {
    n = 0;
    const { blocks } = buildSkeletonBlocks({
      skeleton: { blocks: [{ key: 'top_stories' }, { key: 'top_stories' }] },
      defs,
      defaultsFor: () => ({}),
      newId,
    });
    expect(blocks.map((b) => b.id)).toEqual(['id-1', 'id-2']);
  });
});
