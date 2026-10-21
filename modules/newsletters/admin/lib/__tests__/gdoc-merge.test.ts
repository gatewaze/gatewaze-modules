import { describe, expect, it } from 'vitest';
import { applyGdocMerge, blockHasContent, defaultChoice, planGdocMerge, researchEditsFromDoc, type GdocProposal } from '../gdoc-merge';
import type { EditionBlock, NewsletterEdition, BlockTemplate } from '../../utils';

const tpl = (block_type: string, schema: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: `def-${block_type}`, name: block_type, block_type, content: { html_template: '', schema, has_bricks: false }, ...extra }) as unknown as BlockTemplate;

const leadTpl = tpl('lead', { title: { type: 'text' }, body: { type: 'richtext' }, eyebrow: { type: 'text', default: 'THE LEAD' } });
const storiesTpl = tpl('stories', { eyebrow: { type: 'text', default: 'TOP STORIES' }, items: { type: 'array', fields: { headline: { type: 'text' } } } });
const findsTpl = tpl('finds', { items: { type: 'array', fields: { headline: { type: 'text' } } } });
const blogsTpl = tpl('blogs', {
  eyebrow: { type: 'text', default: 'BLOGS' },
  groups: { type: 'array', fields: { group: { type: 'text' }, items: { type: 'array', fields: { headline: { type: 'text' }, url: { type: 'text' } } } } },
}, {
  source_kind: 'research',
  data_source: { kind: 'research', output: { field: 'groups', format: 'array' }, transform: { group_by: 'foundation' } },
  binding_hash: 'h1',
});

const block = (id: string, t: BlockTemplate, content: Record<string, unknown>, sort = 0) =>
  ({ id, block_template: t, content, sort_order: sort, bricks: [] }) as unknown as EditionBlock;

const edition = (): NewsletterEdition => ({
  id: 'ed', edition_date: '2026-10-21', subject: 'Untitled', preheader: 'Existing preheader',
  blocks: [
    block('b-lead', leadTpl, { title: '', body: '', eyebrow: 'THE LEAD' }, 0),
    block('b-stories', storiesTpl, { eyebrow: 'TOP STORIES', items: [{ headline: 'Already here' }] }, 1000),
    block('b-blogs', blogsTpl, { eyebrow: 'BLOGS', groups: [{ key: 'k1', group: 'LF', headline: 'Researched post' }] }, 2000),
  ],
} as unknown as NewsletterEdition);

const proposal: GdocProposal = {
  subject: 'Agents get a protocol upgrade',
  preheader: 'New preheader',
  blocks: [
    { target_block_id: 'b-lead', block_type: 'lead', source_heading: 'THE LEAD', content: { title: 'Lead title', body: '<p>Body</p>' } },
    { target_block_id: 'b-stories', block_type: 'stories', source_heading: 'TOP STORIES', content: { items: [{ headline: 'Doc story' }] } },
    { target_block_id: 'b-blogs', block_type: 'blogs', source_heading: 'BLOGS', content: { groups: [{ group: 'CNCF', items: [{ headline: 'Doc post', url: 'https://x.example/p' }] }] } },
    { target_block_id: null, block_type: 'finds', source_heading: 'FINDS', content: { items: [{ headline: 'A find' }] } },
  ],
  unmapped: [],
};

describe('blockHasContent', () => {
  it('ignores fields left at their defaults', () => {
    expect(blockHasContent(edition().blocks[0])).toBe(false);
    expect(blockHasContent(edition().blocks[1])).toBe(true);
  });
  it('reads a research block through its resolved research layer', () => {
    expect(blockHasContent(edition().blocks[2])).toBe(true);
    expect(blockHasContent(block('x', blogsTpl, { eyebrow: 'BLOGS', groups: [] }))).toBe(false);
  });
});

describe('planGdocMerge', () => {
  const plan = planGdocMerge(edition(), proposal, [leadTpl, storiesTpl, findsTpl, blogsTpl]);
  it('marks targets that already have content as conflicts', () => {
    const byId = Object.fromEntries(plan.map((c) => [c.id, c]));
    expect(byId.subject.conflict).toBe(false); // "Untitled" counts as empty
    expect(byId.preheader.conflict).toBe(true);
    expect(byId['block:b-lead'].conflict).toBe(false);
    expect(byId['block:b-stories'].conflict).toBe(true);
    expect(byId['block:b-blogs']).toMatchObject({ conflict: true, research: true });
    expect(byId['new:3']).toMatchObject({ kind: 'new_block', block_type: 'finds' });
  });
  it('defaults to filling empty targets and keeping filled ones', () => {
    expect(plan.map((c) => [c.id, defaultChoice(c)])).toEqual([
      ['subject', 'doc'], ['preheader', 'keep'], ['block:b-lead', 'doc'], ['block:b-stories', 'keep'], ['block:b-blogs', 'keep'], ['new:3', 'doc'],
    ]);
  });
});

describe('applyGdocMerge', () => {
  it('applies the chosen changes and leaves the rest alone', () => {
    const ed = edition();
    const plan = planGdocMerge(ed, proposal, [leadTpl, storiesTpl, findsTpl, blogsTpl]);
    const r = applyGdocMerge(ed, plan, { 'block:b-blogs': 'doc' }, [leadTpl, storiesTpl, findsTpl, blogsTpl], () => 'new-id');
    expect(r.edition.subject).toBe('Agents get a protocol upgrade');
    expect(r.edition.preheader).toBe('Existing preheader');
    expect(r.edition.blocks[0].content).toMatchObject({ title: 'Lead title', body: '<p>Body</p>', eyebrow: 'THE LEAD' });
    expect(r.edition.blocks[0].content).toEqual({ title: 'Lead title', body: '<p>Body</p>', eyebrow: 'THE LEAD' });
    expect(r.edition.blocks[1].content.items).toEqual([{ headline: 'Already here' }]);
    // Research block: the content keeps the research layer; the doc goes into the edit layer.
    expect(r.edition.blocks[2].content.groups).toEqual([{ key: 'k1', group: 'LF', headline: 'Researched post' }]);
    expect(r.researchEdits).toEqual([{ blockId: 'b-blogs', edits: {
      format: 'array', binding_hash: 'h1', removed: ['k1'],
      added: [{ headline: 'Doc post', url: 'https://x.example/p', group: 'CNCF', key: 'gdoc:1:doc-post' }],
    } }]);
    const added = r.edition.blocks[3];
    expect(added).toMatchObject({ id: 'new-id', sort_order: 3000 });
    expect(added.content).toEqual({ items: [{ headline: 'A find' }] });
    expect(r.applied).toBe(4);
  });
  it('does not touch the original edition', () => {
    const ed = edition();
    const plan = planGdocMerge(ed, proposal, [leadTpl, storiesTpl, findsTpl, blogsTpl]);
    applyGdocMerge(ed, plan, {}, [leadTpl, storiesTpl, findsTpl, blogsTpl], () => 'n');
    expect(ed.blocks[0].content.title).toBe('');
  });
});

describe('replace on "use document"', () => {
  it('drops fields the doc does not mention but keeps the section label', () => {
    const ed = edition();
    ed.blocks[0] = block('b-lead', leadTpl, { title: 'Old', body: '<p>Old</p>', eyebrow: 'MY LABEL' });
    const plan = planGdocMerge(ed, { ...proposal, blocks: [{ target_block_id: 'b-lead', block_type: 'lead', source_heading: null, content: { body: '<p>New</p>' } }] }, [leadTpl]);
    const r = applyGdocMerge(ed, plan, { 'block:b-lead': 'doc' }, [leadTpl], () => 'n');
    expect(r.edition.blocks[0].content).toEqual({ title: '', body: '<p>New</p>', eyebrow: 'MY LABEL' });
  });
});

describe('researchEditsFromDoc', () => {
  it('needs a binding hash', () => {
    const t = { ...blogsTpl, binding_hash: undefined } as unknown as BlockTemplate;
    expect(researchEditsFromDoc(block('x', t, {}), { groups: [{ group: 'A', items: [{ headline: 'h' }] }] })).toBeNull();
  });
});
