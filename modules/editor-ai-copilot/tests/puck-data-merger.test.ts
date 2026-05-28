import { describe, expect, it } from 'vitest';
import {
  mergeAiResponse,
  type PuckData,
} from '../admin/components/puck-data-merger.js';

const root: PuckData['root'] = { props: { title: 'Site' } };

const block = (id: string, type = 'hero', extra: Record<string, unknown> = {}) => ({
  type,
  props: { id, ...extra },
});

describe('mergeAiResponse — replace', () => {
  it('replaces content and preserves root', () => {
    const prev: PuckData = { content: [block('a'), block('b')], root };
    const ai: PuckData = { content: [block('x')], root: { props: {} } };
    const out = mergeAiResponse({ mode: 'replace', prev, ai });
    expect(out.data.content.map((b) => b.props.id)).toEqual(['x']);
    expect(out.data.root).toBe(root);
    expect(out.warnings).toEqual([]);
  });

  it('assigns ids to AI blocks missing them', () => {
    const prev: PuckData = { content: [], root };
    const ai: PuckData = {
      content: [{ type: 'hero', props: { id: '' as unknown as string } }],
      root: { props: {} },
    };
    const out = mergeAiResponse({ mode: 'replace', prev, ai });
    expect(out.data.content[0]?.props.id).toBeTruthy();
  });
});

describe('mergeAiResponse — append', () => {
  it('appends AI blocks after existing content', () => {
    const prev: PuckData = { content: [block('a'), block('b')], root };
    const ai: PuckData = { content: [block('c')], root: { props: {} } };
    const out = mergeAiResponse({ mode: 'append', prev, ai });
    expect(out.data.content.map((b) => b.props.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeAiResponse — insert-after', () => {
  it('splices AI blocks after the anchor', () => {
    const prev: PuckData = { content: [block('a'), block('b'), block('c')], root };
    const ai: PuckData = { content: [block('x'), block('y')], root: { props: {} } };
    const out = mergeAiResponse({ mode: 'insert-after', prev, ai, anchorBlockId: 'b' });
    expect(out.data.content.map((b) => b.props.id)).toEqual(['a', 'b', 'x', 'y', 'c']);
    expect(out.warnings).toEqual([]);
  });

  it('warns + appends when anchor not found', () => {
    const prev: PuckData = { content: [block('a')], root };
    const ai: PuckData = { content: [block('z')], root: { props: {} } };
    const out = mergeAiResponse({ mode: 'insert-after', prev, ai, anchorBlockId: 'missing' });
    expect(out.data.content.map((b) => b.props.id)).toEqual(['a', 'z']);
    expect(out.warnings[0]?.code).toBe('anchor_not_found');
  });

  it('warns + appends when anchorBlockId omitted', () => {
    const prev: PuckData = { content: [block('a')], root };
    const ai: PuckData = { content: [block('z')], root: { props: {} } };
    const out = mergeAiResponse({ mode: 'insert-after', prev, ai });
    expect(out.warnings[0]?.code).toBe('missing_anchor');
  });
});

describe('mergeAiResponse — edit', () => {
  it('preserves ids on matched blocks, warns on unmatched', () => {
    const prev: PuckData = { content: [block('a'), block('b')], root };
    const ai: PuckData = {
      content: [block('a', 'hero', { headline: 'updated' }), block('ghost')],
      root: { props: {} },
    };
    const out = mergeAiResponse({ mode: 'edit', prev, ai });
    expect(out.data.content[0]?.props).toMatchObject({ id: 'a', headline: 'updated' });
    // 'ghost' was not in prev — treated as a fresh insert with a new id.
    expect(out.data.content[1]?.props.id).not.toBe('ghost');
    expect(out.warnings.some((w) => w.code === 'ai_unmatched_id')).toBe(true);
  });

  it('flags dropped blocks', () => {
    const prev: PuckData = { content: [block('a'), block('b'), block('c')], root };
    const ai: PuckData = { content: [block('a'), block('b')], root: { props: {} } };
    const out = mergeAiResponse({ mode: 'edit', prev, ai });
    expect(out.warnings.some((w) => w.code === 'edit_dropped_blocks')).toBe(true);
  });
});

describe('mergeAiResponse — edit-block', () => {
  it('replaces props on the target id, keeping the id stable', () => {
    const prev: PuckData = { content: [block('a', 'hero'), block('b', 'cta')], root };
    const ai: PuckData = {
      content: [{ type: 'hero', props: { id: 'ignored', headline: 'NEW' } }],
      root: { props: {} },
    };
    const out = mergeAiResponse({ mode: 'edit-block', prev, ai, blockId: 'a' });
    expect(out.data.content[0]?.props.id).toBe('a');
    expect(out.data.content[0]?.props.headline).toBe('NEW');
    expect(out.data.content[1]).toBe(prev.content[1]);
  });

  it('recurses into nested children when target is a brick', () => {
    const prev: PuckData = {
      content: [
        {
          type: 'columns',
          props: {
            id: 'parent',
            children: [{ type: 'text', props: { id: 'nested', body: 'old' } }],
          },
        },
      ],
      root,
    };
    const ai: PuckData = {
      content: [{ type: 'text', props: { id: 'nested', body: 'new' } }],
      root: { props: {} },
    };
    const out = mergeAiResponse({ mode: 'edit-block', prev, ai, blockId: 'nested' });
    const children = out.data.content[0]?.props.children as Array<{ props: { body: string; id: string } }>;
    expect(children[0]?.props.body).toBe('new');
    expect(children[0]?.props.id).toBe('nested');
  });

  it('warns when blockId missing', () => {
    const prev: PuckData = { content: [block('a')], root };
    const ai: PuckData = { content: [block('a')], root: { props: {} } };
    const out = mergeAiResponse({ mode: 'edit-block', prev, ai });
    expect(out.warnings[0]?.code).toBe('missing_blockId');
    expect(out.data).toBe(prev);
  });

  it('warns when target id not found in prev', () => {
    const prev: PuckData = { content: [block('a')], root };
    const ai: PuckData = { content: [block('zzz')], root: { props: {} } };
    const out = mergeAiResponse({ mode: 'edit-block', prev, ai, blockId: 'zzz' });
    expect(out.warnings[0]?.code).toBe('block_not_found_at_merge');
  });

  it('warns when AI response has no block', () => {
    const prev: PuckData = { content: [block('a')], root };
    const ai: PuckData = { content: [], root: { props: {} } };
    const out = mergeAiResponse({ mode: 'edit-block', prev, ai, blockId: 'a' });
    expect(out.warnings[0]?.code).toBe('edit_block_empty_response');
  });
});
