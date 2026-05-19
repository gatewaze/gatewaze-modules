import { describe, it, expect } from 'vitest';
import { flattenTree, descendantIds, buildPath } from '../lib/tree';

const rows = [
  { id: 'A', parent_task_id: null, sort_index: 'A' },
  { id: 'B', parent_task_id: null, sort_index: 'M' },
  { id: 'C', parent_task_id: 'A',  sort_index: 'A' },
  { id: 'D', parent_task_id: 'A',  sort_index: 'M' },
  { id: 'E', parent_task_id: 'C',  sort_index: 'A' },
];

describe('tree.flattenTree', () => {
  it('produces depth-first DFS order', () => {
    const out = flattenTree(rows);
    expect(out.map(r => r.id)).toEqual(['A', 'C', 'E', 'D', 'B']);
  });

  it('sets correct depth', () => {
    const out = flattenTree(rows);
    expect(out.find(r => r.id === 'A')!.depth).toBe(0);
    expect(out.find(r => r.id === 'C')!.depth).toBe(1);
    expect(out.find(r => r.id === 'E')!.depth).toBe(2);
  });
});

describe('tree.descendantIds', () => {
  it('returns all descendants', () => {
    const d = descendantIds('A', rows);
    expect([...d].sort()).toEqual(['C', 'D', 'E']);
  });

  it('returns empty set for leaf', () => {
    expect([...descendantIds('E', rows)]).toEqual([]);
  });
});

describe('tree.buildPath', () => {
  it('returns sort-index path from root', () => {
    expect(buildPath('E', rows)).toEqual(['A', 'A', 'A']);
    expect(buildPath('D', rows)).toEqual(['A', 'M']);
  });
});
