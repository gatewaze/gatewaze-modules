/**
 * Tree utilities for the nested-task structure (spec §13.5).
 */

import type { Task, TreeTask, Uuid } from './types.js';

interface RowWithSort {
  id: Uuid;
  parent_task_id: Uuid | null;
  sort_index: string;
}

/**
 * Build a flat depth-first order from a set of task rows by walking
 * parent → children based on `parent_task_id` and `sort_index`.
 */
export function flattenTree<T extends RowWithSort>(rows: T[]): Array<T & { depth: number; path: string[] }> {
  // Index by parent.
  const childMap = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.parent_task_id ?? '__root__';
    let list = childMap.get(key);
    if (!list) {
      list = [];
      childMap.set(key, list);
    }
    list.push(r);
  }
  for (const list of childMap.values()) {
    list.sort((a, b) => (a.sort_index < b.sort_index ? -1 : a.sort_index > b.sort_index ? 1 : 0));
  }
  const out: Array<T & { depth: number; path: string[] }> = [];
  function walk(parent: string | null, depth: number, parentPath: string[]) {
    const list = childMap.get(parent ?? '__root__') ?? [];
    for (const r of list) {
      const path = [...parentPath, r.sort_index];
      out.push({ ...r, depth, path });
      walk(r.id, depth + 1, path);
    }
  }
  walk(null, 0, []);
  return out;
}

/**
 * Set of all descendant task ids of `taskId`.
 */
export function descendantIds(taskId: Uuid, rows: RowWithSort[]): Set<Uuid> {
  const out = new Set<Uuid>();
  const childMap = new Map<string, Uuid[]>();
  for (const r of rows) {
    const key = r.parent_task_id ?? '__root__';
    let list = childMap.get(key);
    if (!list) {
      list = [];
      childMap.set(key, list);
    }
    list.push(r.id);
  }
  function walk(id: Uuid) {
    for (const child of childMap.get(id) ?? []) {
      out.add(child);
      walk(child);
    }
  }
  walk(taskId);
  return out;
}

/**
 * Path of sort-index strings from root to taskId.
 */
export function buildPath(taskId: Uuid, rows: RowWithSort[]): string[] {
  const byId = new Map(rows.map(r => [r.id, r]));
  const path: string[] = [];
  let cur: RowWithSort | undefined = byId.get(taskId);
  while (cur) {
    path.unshift(cur.sort_index);
    if (!cur.parent_task_id) break;
    cur = byId.get(cur.parent_task_id);
  }
  return path;
}

export function tasksToTree(rows: Task[]): TreeTask[] {
  return flattenTree(rows).map(r => ({ ...(r as Task), depth: r.depth, path: r.path }));
}
