// Pins the ordered deploy-set semantics behind the shared <TestEnvSetBuilder>
// (extracted from TestEnvPanel for the per-profile Overview panels). This
// module's vitest env is 'node' (no jsdom), so the component itself can't be
// rendered here — the pure logic in testEnvSet.ts is the contract: the set is
// ORDERED, same-repo order is the host's merge order, reorder moves swap
// within a repo group only, and the Overview's related-PR PAT source is any
// profile-matching project.
import { describe, it, expect } from 'vitest';
import {
  testEnvProfile, inSet, toggleEntry, addEntry, moveWithinRepo, groupRepos, pickRelatedProject,
} from '../components/testEnvSet';

const e = (repo: string, number: number) => ({ repo, number });

describe('testEnvProfile', () => {
  it('maps Gatewaze (exact) to gatewaze and LFX-ish names to lfx; everything else hides', () => {
    expect(testEnvProfile('Gatewaze')).toBe('gatewaze');
    expect(testEnvProfile('gatewaze')).toBeNull();       // exact-match only
    expect(testEnvProfile('LFX One')).toBe('lfx');
    expect(testEnvProfile('lfx-self-serve')).toBe('lfx');
    expect(testEnvProfile('AAIF')).toBeNull();
    expect(testEnvProfile(undefined)).toBeNull();
  });
});

describe('toggleEntry / inSet', () => {
  it('checking appends at the end (append order = merge order)', () => {
    const s = toggleEntry([e('a', 1)], 'b', 2);
    expect(s).toEqual([e('a', 1), e('b', 2)]);
    expect(inSet(s, 'b', 2)).toBe(true);
  });

  it('unchecking removes exactly that entry and keeps the rest in order', () => {
    const s = toggleEntry([e('a', 1), e('b', 2), e('a', 3)], 'b', 2);
    expect(s).toEqual([e('a', 1), e('a', 3)]);
  });
});

describe('addEntry', () => {
  it('appends a valid new entry', () => {
    expect(addEntry([e('a', 1)], 'a', 2)).toEqual([e('a', 1), e('a', 2)]);
  });

  it('is a no-op (same reference) for duplicates and invalid numbers', () => {
    const s = [e('a', 1)];
    expect(addEntry(s, 'a', 1)).toBe(s);      // duplicate
    expect(addEntry(s, 'a', 0)).toBe(s);      // below range
    expect(addEntry(s, 'a', 1.5)).toBe(s);    // not an integer
    expect(addEntry(s, 'a', 100000)).toBe(s); // above range
  });
});

describe('moveWithinRepo', () => {
  // Same-repo order is the host's merge order; cross-repo entries in between
  // are skipped and keep their positions.
  const set = [e('a', 1), e('b', 5), e('a', 2), e('a', 3)];

  it('swaps with the nearest same-repo entry, skipping other repos', () => {
    expect(moveWithinRepo(set, 2, -1)).toEqual([e('a', 2), e('b', 5), e('a', 1), e('a', 3)]);
  });

  it('moves down within the group', () => {
    expect(moveWithinRepo(set, 2, 1)).toEqual([e('a', 1), e('b', 5), e('a', 3), e('a', 2)]);
  });

  it('is a no-op at the group boundary', () => {
    expect(moveWithinRepo(set, 0, -1)).toBe(set);   // first a upward
    expect(moveWithinRepo(set, 3, 1)).toBe(set);    // last a downward
    expect(moveWithinRepo(set, 1, 1)).toBe(set);    // only b, nowhere to go
  });

  it('is a no-op for an out-of-range index', () => {
    expect(moveWithinRepo(set, 9, 1)).toBe(set);
  });

  it('never reorders across repos: a full pass keeps each repo’s slot positions', () => {
    const moved = moveWithinRepo(set, 3, -1);
    expect(moved.map((x) => x.repo)).toEqual(set.map((x) => x.repo));
  });
});

describe('groupRepos', () => {
  it('returns repos in first-appearance order, deduped', () => {
    expect(groupRepos([e('b', 1), e('a', 2), e('b', 3)])).toEqual(['b', 'a']);
    expect(groupRepos([])).toEqual([]);
  });
});

describe('pickRelatedProject', () => {
  const projects = [
    { id: '1', name: 'AAIF' },
    { id: '2', name: 'LFX One' },
    { id: '3', name: 'Gatewaze' },
    { id: '4', name: 'LFX Two' },
  ];

  it('returns the first project matching the profile', () => {
    expect(pickRelatedProject(projects, 'lfx')?.id).toBe('2');
    expect(pickRelatedProject(projects, 'gatewaze')?.id).toBe('3');
  });

  it('returns null when no project matches (related lookups skip silently)', () => {
    expect(pickRelatedProject([{ id: '1', name: 'AAIF' }], 'lfx')).toBeNull();
    expect(pickRelatedProject([], 'gatewaze')).toBeNull();
  });
});
