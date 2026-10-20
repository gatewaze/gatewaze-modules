import { describe, expect, it } from 'vitest';
import { applyResearchReplacements, diffResearchOnly, type SnapshotBlock } from '../research-conflict.js';

const items1 = [{ key: 'a', group: 'CNCF', headline: 'A' }];
const items2 = [{ key: 'a', group: 'CNCF', headline: 'A' }, { key: 'b', group: 'CNCF', headline: 'B' }];

const loaded: SnapshotBlock[] = [
  { id: 'intro', content: { body: '<p>hi</p>' }, sort_order: 1000, templates_block_def_id: 'def-intro' },
  { id: 'blogs', content: { eyebrow: 'LF BLOGS', items: items1 }, sort_order: 2000, templates_block_def_id: 'def-blogs' },
];
const research = { blogs: 'items' };
const clone = (b: SnapshotBlock[]): SnapshotBlock[] => JSON.parse(JSON.stringify(b));

describe('diffResearchOnly', () => {
  it('identical snapshots: research-only with nothing to replace', () => {
    const d = diffResearchOnly(loaded, clone(loaded), research);
    expect(d).toEqual({ only_research: true, replacements: [] });
  });

  it('a run landed: only the research field of a research block changed', () => {
    const fresh = clone(loaded);
    fresh[1].content.items = items2;
    const d = diffResearchOnly(loaded, fresh, research);
    expect(d.only_research).toBe(true);
    expect(d.replacements).toEqual([{ block_id: 'blogs', field: 'items', research: items2 }]);
  });

  it('an edit layer landed (another tab pinned something): adopted too', () => {
    const fresh = clone(loaded);
    fresh[1].content.research_edits = { format: 'array', binding_hash: 'h', pinned: ['a'] };
    const d = diffResearchOnly(loaded, fresh, research);
    expect(d.only_research).toBe(true);
    expect(d.replacements).toEqual([{ block_id: 'blogs', research_edits: { format: 'array', binding_hash: 'h', pinned: ['a'] } }]);
  });

  it('both layers changed on one block: one replacement carrying both', () => {
    const fresh = clone(loaded);
    fresh[1].content.items = items2;
    fresh[1].content.research_edits = { format: 'array', binding_hash: 'h' };
    const d = diffResearchOnly(loaded, fresh, research);
    expect(d.replacements).toHaveLength(1);
    expect(d.replacements[0]).toMatchObject({ block_id: 'blogs', field: 'items', research_edits: { format: 'array', binding_hash: 'h' } });
  });

  it('key order inside content does not count as a change', () => {
    const fresh = clone(loaded);
    fresh[1].content = { items: items1, eyebrow: 'LF BLOGS' };
    expect(diffResearchOnly(loaded, fresh, research).only_research).toBe(true);
  });

  it('a non-research field of a research block changed: not research-only', () => {
    const fresh = clone(loaded);
    fresh[1].content.eyebrow = 'Changed elsewhere';
    const d = diffResearchOnly(loaded, fresh, research);
    expect(d.only_research).toBe(false);
    expect(d.reason).toMatch(/blogs\.eyebrow/);
  });

  it('the same field name on a NON-research block changed: not research-only', () => {
    const fresh = clone(loaded);
    fresh[0].content.items = items2;
    expect(diffResearchOnly(loaded, fresh, research).only_research).toBe(false);
  });

  it('a block added, removed, moved, or re-templated elsewhere: not research-only', () => {
    expect(diffResearchOnly(loaded, [...clone(loaded), { id: 'x', content: {}, sort_order: 3000 }], research).only_research).toBe(false);
    expect(diffResearchOnly(loaded, clone(loaded).slice(0, 1), research).only_research).toBe(false);
    const moved = clone(loaded); moved[0].sort_order = 5000;
    expect(diffResearchOnly(loaded, moved, research).only_research).toBe(false);
    const retpl = clone(loaded); retpl[1].templates_block_def_id = 'def-other';
    expect(diffResearchOnly(loaded, retpl, research).only_research).toBe(false);
  });

  it('same count, one id swapped for another: not research-only', () => {
    const fresh = clone(loaded);
    fresh[0].id = 'intro-replacement';
    const d = diffResearchOnly(loaded, fresh, research);
    expect(d.only_research).toBe(false);
  });

  it('same count, a duplicated id hiding a replaced block: not research-only', () => {
    // loaded has the same id twice (a stale snapshot), fresh has that id once
    // plus a block the loaded snapshot never had.
    const dupLoaded = [clone(loaded)[1], clone(loaded)[1]];
    const fresh = [clone(loaded)[1], { id: 'new-block', content: {}, sort_order: 2000, templates_block_def_id: 'def-blogs' }];
    expect(diffResearchOnly(dupLoaded, fresh, research).only_research).toBe(false);
  });

  it('a research field changed AND another block was edited: the other edit wins (not research-only)', () => {
    const fresh = clone(loaded);
    fresh[1].content.items = items2;
    fresh[0].content.body = '<p>bye</p>';
    expect(diffResearchOnly(loaded, fresh, research).only_research).toBe(false);
  });
});

describe('applyResearchReplacements', () => {
  it('replaces only the named fields, keeps the author’s other dirty fields, maps the research value', () => {
    const inMemory = [
      { id: 'intro', content: { body: '<p>typing…</p>' } },
      { id: 'blogs', content: { eyebrow: 'My new eyebrow', items: items1, research_edits: { format: 'array', binding_hash: 'h', removed: ['a'] } } },
    ];
    const out = applyResearchReplacements(inMemory, [{ block_id: 'blogs', field: 'items', research: items2 }], (v) => ({ mapped: v }));
    expect(out[0]).toBe(inMemory[0]);
    expect(out[1].content).toEqual({ eyebrow: 'My new eyebrow', items: { mapped: items2 }, research_edits: { format: 'array', binding_hash: 'h', removed: ['a'] } });
  });

  it('an edit layer replacement overwrites or deletes research_edits', () => {
    const inMemory = [{ id: 'blogs', content: { items: items1, research_edits: { format: 'array', binding_hash: 'h' } } }];
    expect(applyResearchReplacements(inMemory, [{ block_id: 'blogs', research_edits: { format: 'array', binding_hash: 'h', pinned: ['a'] } }])[0].content.research_edits)
      .toEqual({ format: 'array', binding_hash: 'h', pinned: ['a'] });
    expect('research_edits' in applyResearchReplacements(inMemory, [{ block_id: 'blogs', research_edits: undefined }])[0].content).toBe(false);
  });
});
