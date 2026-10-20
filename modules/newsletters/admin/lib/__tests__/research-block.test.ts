import { describe, expect, it } from 'vitest';
import { preserveResearchLayers, renderContentOf, researchBindingOf, researchUseCaseOf, withBindingHashes } from '../research-block.js';
import { bindingHash } from '../../../lib/research-merge.js';
import type { BlockTemplate } from '../../utils/types.js';

const binding = {
  kind: 'research',
  input: { kind: 'discovery_posts' },
  transform: { kind: 'template', group_by: 'foundation', max_per_group: 2 },
  output: { field: 'items' },
  schedule: 'edition',
};

const tpl = (over: Partial<BlockTemplate> = {}): BlockTemplate => ({
  id: 'def-blogs',
  name: 'LF blogs',
  block_type: 'lf_blogs',
  render_kind: 'declarative',
  source_kind: 'research',
  data_source: binding,
  content: { html_template: '<Section/>', schema: {} },
  ...over,
});

const items = [
  { key: 'a', group: 'CNCF', headline: 'A', published_at: '2026-10-10T00:00:00Z' },
  { key: 'b', group: 'LF AI', headline: 'B', published_at: '2026-10-11T00:00:00Z' },
];

describe('researchBindingOf', () => {
  it('only a source_kind=research template with a research data_source and an output field is a binding', () => {
    expect(researchBindingOf(tpl())).toMatchObject({ output: { field: 'items' } });
    expect(researchBindingOf(tpl({ source_kind: 'static' }))).toBeNull();
    expect(researchBindingOf(tpl({ data_source: { adapter: 'http', url: 'https://x' } }))).toBeNull();
    expect(researchBindingOf(tpl({ data_source: { ...binding, output: {} } }))).toBeNull();
    expect(researchBindingOf(undefined)).toBeNull();
  });
  it('the use case comes from the transform recipe, else the input recipe, else null', () => {
    expect(researchUseCaseOf(researchBindingOf(tpl()))).toBeNull();
    expect(researchUseCaseOf(researchBindingOf(tpl({ data_source: { ...binding, input: { kind: 'recipe', use_case: 'in' } } })))).toBe('in');
    expect(researchUseCaseOf(researchBindingOf(tpl({ data_source: { ...binding, input: { kind: 'recipe', use_case: 'in' }, transform: { kind: 'recipe', use_case: 'tr' } } })))).toBe('tr');
  });
});

describe('renderContentOf', () => {
  it('a research block renders the resolved, grouped field with the edit layer applied and removed', async () => {
    const hash = await bindingHash(binding);
    const block = {
      block_template: tpl({ binding_hash: hash }),
      content: { eyebrow: 'LF BLOGS', items, research_edits: { format: 'array', binding_hash: hash, removed: ['b'] } },
    };
    const out = renderContentOf(block);
    expect(out.eyebrow).toBe('LF BLOGS');
    expect('research_edits' in out).toBe(false);
    expect(out.items).toEqual([{ group: 'CNCF', items: [items[0]] }]);
  });
  it('without a binding hash the edit layer is set aside, never applied against an unknown binding', () => {
    const out = renderContentOf({ block_template: tpl(), content: { items, research_edits: { format: 'array', binding_hash: 'x', removed: ['b'] } } });
    expect((out.items as unknown[]).length).toBe(2);
  });
  it('non-research blocks pass through by reference', () => {
    const content = { body: '<p>hi</p>', research_edits: { not: 'touched' } };
    expect(renderContentOf({ block_template: tpl({ source_kind: 'static' }), content })).toBe(content);
  });
});

describe('preserveResearchLayers', () => {
  it('the canvas props never write the research field or the edit layer back', () => {
    const prev = { eyebrow: 'old', items, research_edits: { format: 'array', binding_hash: 'h', pinned: ['a'] } };
    const fromCanvas = { eyebrow: 'new', items: [{ group: 'CNCF', items: [items[0]] }] };
    expect(preserveResearchLayers(tpl(), fromCanvas, prev)).toEqual({ eyebrow: 'new', items, research_edits: prev.research_edits });
  });
  it('a block with no previous state keeps an empty research layer and no edit layer', () => {
    const fromCanvas = { eyebrow: 'x', items: [{ group: 'CNCF', items: [] }], research_edits: { junk: true } };
    expect(preserveResearchLayers(tpl(), fromCanvas, undefined)).toEqual({ eyebrow: 'x', items: [] });
  });
  it('non-research blocks are returned as given', () => {
    const next = { body: 'typed' };
    expect(preserveResearchLayers(tpl({ source_kind: 'static' }), next, { body: 'old' })).toBe(next);
  });
});

describe('withBindingHashes', () => {
  it('stamps the sha1 of the canonical binding on research templates only, once per def id', async () => {
    const out = await withBindingHashes([tpl(), tpl({ id: 'def-intro', source_kind: 'static', data_source: null }), tpl()]);
    const expected = await bindingHash(binding);
    expect(out[0].binding_hash).toBe(expected);
    expect(out[2].binding_hash).toBe(expected);
    expect(out[1].binding_hash).toBeUndefined();
    expect(expected).toMatch(/^[0-9a-f]{40}$/);
  });
});
