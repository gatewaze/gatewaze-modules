/**
 * User-block persistence. v1 stores in localStorage keyed by the
 * newsletter's collection id; the read/write API is shaped so the
 * concrete backing store can flip to DB-backed (the
 * `newsletters_template_collections.metadata.user_blocks` JSON column)
 * in a follow-up without changing call sites.
 *
 * Why localStorage v1: getting end-to-end UX shipped now without
 * threading a supabase write callback through 3 layers of components.
 * The shape of `UserBlock` matches what we'd persist to the DB so the
 * upgrade is a swap of `loadUserBlocks` / `saveUserBlocks`
 * implementations.
 */
import type { UserBlock } from './types.js';

const STORAGE_KEY_PREFIX = 'gatewaze:newsletter-user-blocks:v1:';

function key(scopeId: string): string {
  return `${STORAGE_KEY_PREFIX}${scopeId}`;
}

export function loadUserBlocks(scopeId: string): UserBlock[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(key(scopeId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Light shape-check to avoid corrupted entries crashing the canvas.
    return parsed.filter((b): b is UserBlock => {
      return (
        b != null &&
        typeof b === 'object' &&
        typeof (b as { id?: unknown }).id === 'string' &&
        typeof (b as { label?: unknown }).label === 'string' &&
        typeof (b as { tree?: unknown }).tree === 'object' &&
        (b as { tree: { type?: unknown } }).tree != null &&
        typeof (b as { tree: { type?: unknown } }).tree.type === 'string'
      );
    });
  } catch {
    return [];
  }
}

export function saveUserBlocks(scopeId: string, blocks: ReadonlyArray<UserBlock>): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key(scopeId), JSON.stringify(blocks));
}

export function appendUserBlock(scopeId: string, block: UserBlock): UserBlock[] {
  const next = [...loadUserBlocks(scopeId), block];
  saveUserBlocks(scopeId, next);
  return next;
}

export function removeUserBlock(scopeId: string, id: string): UserBlock[] {
  const next = loadUserBlocks(scopeId).filter((b) => b.id !== id);
  saveUserBlocks(scopeId, next);
  return next;
}
