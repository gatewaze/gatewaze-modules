/**
 * User-block persistence — DB-backed via Supabase.
 *
 * Each collection's saved blocks live in
 * `newsletters_template_collections.metadata.user_blocks` (JSON
 * array). Read-modify-write so other metadata keys are preserved
 * (the column is shared with newsletter setup metadata, accent
 * category, etc.).
 *
 * The previous v1 of this module stored user blocks in localStorage.
 * That worked for a single browser session but didn't survive
 * reloads on different devices and didn't share between editors of
 * the same newsletter. Switching to the DB column keeps blocks
 * scoped per-newsletter and visible to every operator on the team.
 *
 * Race condition: two operators saving simultaneously will last-
 * write-wins. v2 might add an op-log column for proper merging; v1
 * accepts the loss for the simpler shape.
 */
import { supabase } from '@/lib/supabase';
import type { UserBlock } from './types.js';

interface Row {
  metadata: Record<string, unknown> | null;
}

export async function loadUserBlocks(collectionId: string): Promise<UserBlock[]> {
  if (!collectionId) return [];
  const { data, error } = await supabase
    .from('newsletters_template_collections')
    .select('metadata')
    .eq('id', collectionId)
    .maybeSingle<Row>();
  if (error || !data) return [];
  const arr = (data.metadata as { user_blocks?: unknown } | null)?.user_blocks;
  if (!Array.isArray(arr)) return [];
  return arr.filter(isUserBlock);
}

export async function saveUserBlocks(
  collectionId: string,
  blocks: ReadonlyArray<UserBlock>,
): Promise<void> {
  if (!collectionId) return;
  // Read-modify-write: preserve sibling keys in metadata.
  const { data: prev, error: readError } = await supabase
    .from('newsletters_template_collections')
    .select('metadata')
    .eq('id', collectionId)
    .maybeSingle<Row>();
  if (readError) throw new Error(`load metadata for save failed: ${readError.message}`);
  const meta = (prev?.metadata ?? {}) as Record<string, unknown>;
  const next = { ...meta, user_blocks: blocks };
  const { error: writeError } = await supabase
    .from('newsletters_template_collections')
    .update({ metadata: next })
    .eq('id', collectionId);
  if (writeError) throw new Error(`save metadata failed: ${writeError.message}`);
}

export async function appendUserBlock(
  collectionId: string,
  block: UserBlock,
): Promise<UserBlock[]> {
  const current = await loadUserBlocks(collectionId);
  const next = [...current, block];
  await saveUserBlocks(collectionId, next);
  return next;
}

export async function removeUserBlock(
  collectionId: string,
  id: string,
): Promise<UserBlock[]> {
  const current = await loadUserBlocks(collectionId);
  const next = current.filter((b) => b.id !== id);
  await saveUserBlocks(collectionId, next);
  return next;
}

function isUserBlock(v: unknown): v is UserBlock {
  if (v == null || typeof v !== 'object') return false;
  const r = v as { id?: unknown; label?: unknown; tree?: unknown };
  return (
    typeof r.id === 'string' &&
    typeof r.label === 'string' &&
    r.tree != null &&
    typeof r.tree === 'object' &&
    typeof (r.tree as { type?: unknown }).type === 'string'
  );
}
