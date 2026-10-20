import { describe, it, expect } from 'vitest';
import { resolveResearchArray, resolveResearchScalar, resolveBlockContent, asResearchEdits, canonicalJson, bindingHash } from '../research-merge.js';

const H = 'hash-1';
const items = [
  { key: 'a', group: 'CNCF', headline: 'A', published_at: '2026-10-10T00:00:00Z' },
  { key: 'b', group: 'CNCF', headline: 'B', published_at: '2026-10-12T00:00:00Z' },
  { key: 'c', group: 'LF Energy', headline: 'C', published_at: '2026-10-11T00:00:00Z' },
  { key: 'd', group: 'CNCF', headline: 'D', published_at: '2026-10-09T00:00:00Z' },
];

describe('resolveResearchArray', () => {
  it('without edits: grouped alphabetically, newest first, caps applied', () => {
    const r = resolveResearchArray(items, null, { group_by: 'foundation', max_per_group: 2 }, H);
    expect(r.edits_set_aside).toBe(false);
    const groups = r.value as Array<{ group: string; items: Array<{ key: string }> }>;
    expect(groups.map((g) => g.group)).toEqual(['CNCF', 'LF Energy']);
    expect(groups[0].items.map((i) => i.key)).toEqual(['b', 'a']); // d capped
  });
  it('an override, a removal and an addition survive a re-run; a dropped item disappears unless added', () => {
    const edits = { format: 'array', binding_hash: H, overrides: { a: { headline: 'A rewritten' } }, removed: ['b'], added: [{ key: 'x', group: 'CNCF', headline: 'X', published_at: '2026-10-13T00:00:00Z' }] };
    const rerun = items.filter((i) => i.key !== 'c'); // research no longer returns c
    const r = resolveResearchArray(rerun, edits, { group_by: 'foundation' }, H);
    const groups = r.value as Array<{ group: string; items: Array<{ key: string; headline: string }> }>;
    const cncf = groups.find((g) => g.group === 'CNCF')!;
    expect(cncf.items.map((i) => i.key)).toEqual(['x', 'a', 'd']);
    expect(cncf.items.find((i) => i.key === 'a')!.headline).toBe('A rewritten');
    expect(groups.find((g) => g.group === 'LF Energy')).toBeUndefined();
    expect(r.stale_keys).toEqual([]);
  });
  it('pinned keys come first within their group; caps apply AFTER edits so a removal frees a slot', () => {
    const edits = { format: 'array', binding_hash: H, pinned: ['d'], removed: ['b'] };
    const r = resolveResearchArray(items, edits, { group_by: 'foundation', max_per_group: 2 }, H);
    const cncf = (r.value as Array<{ group: string; items: Array<{ key: string }> }>).find((g) => g.group === 'CNCF')!;
    expect(cncf.items.map((i) => i.key)).toEqual(['d', 'a']);
  });
  it('an edit layer from another binding version is set aside; stale keys are reported', () => {
    const r = resolveResearchArray(items, { format: 'array', binding_hash: 'old', removed: ['a'] }, {}, H);
    expect(r.edits_set_aside).toBe(true);
    expect((r.value as unknown[]).length).toBe(4);
    const r2 = resolveResearchArray(items, { format: 'array', binding_hash: H, removed: ['zzz'], pinned: ['yyy'], overrides: { www: { headline: 'x' } } }, {}, H);
    expect(r2.stale_keys.sort()).toEqual(['www', 'yyy', 'zzz']);
  });
  it('flat list when no group_by; max_items caps', () => {
    const r = resolveResearchArray(items, null, { max_items: 2 }, H);
    expect((r.value as Array<{ key: string }>).map((i) => i.key)).toEqual(['b', 'c']);
  });
  it('tolerates garbage research and edit layers', () => {
    expect(resolveResearchArray('nope', 'nope', {}, H).value).toEqual([]);
    expect(resolveResearchArray([{ nokey: 1 }, null, { key: 'k' }], { format: 'array' }, {}, H).value).toEqual([{ key: 'k' }]);
    expect(asResearchEdits({ format: 'array' })).toBeNull();
  });
});

describe('resolveResearchScalar', () => {
  it('the edit wins while present; another binding sets it aside', () => {
    expect(resolveResearchScalar('<p>research</p>', { format: 'richtext', binding_hash: H, value: '<p>edited</p>' }, H)).toMatchObject({ value: '<p>edited</p>', edited: true });
    expect(resolveResearchScalar('<p>research</p>', { format: 'richtext', binding_hash: 'old', value: 'x' }, H)).toMatchObject({ value: '<p>research</p>', edits_set_aside: true });
    expect(resolveResearchScalar('<p>research</p>', null, H)).toMatchObject({ value: '<p>research</p>', edited: false });
  });
  it('a reset ({ format, binding_hash } with no value) means research wins and nothing is edited', () => {
    expect(resolveResearchScalar('<p>research</p>', { format: 'richtext', binding_hash: H }, H)).toMatchObject({ value: '<p>research</p>', edited: false, edits_set_aside: false });
  });
});

describe('resolveBlockContent', () => {
  it('replaces the research field with its resolved value and drops the edit layer; non-research blocks pass through', () => {
    const content = { eyebrow: 'LF BLOGS', items, research_edits: { format: 'array', binding_hash: H, removed: ['a'] } };
    const out = resolveBlockContent(content, { output: { field: 'items', format: 'array' }, transform: { group_by: 'foundation' } }, H);
    expect(out.eyebrow).toBe('LF BLOGS');
    expect(out.research_edits).toBeUndefined();
    expect((out.items as Array<{ group: string; items: unknown[] }>).find((g) => g.group === 'CNCF')!.items.length).toBe(2);
    expect(resolveBlockContent(content, null, H)).toBe(content);
  });
});

describe('bindingHash', () => {
  it('is stable across key order and async-safe', async () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(await bindingHash({ b: 1, a: 2 })).toBe(await bindingHash({ a: 2, b: 1 }));
    expect(await bindingHash({ a: 1 })).not.toBe(await bindingHash({ a: 2 }));
  });
});
