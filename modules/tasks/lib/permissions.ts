/**
 * Board permission helpers (spec §4).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Role, Uuid } from './types.js';

export async function getBoardRole(
  supabase: SupabaseClient,
  userId: Uuid,
  boardId: Uuid,
): Promise<Role | null> {
  const { data } = await supabase
    .from('board_members')
    .select('role')
    .eq('board_id', boardId)
    .eq('admin_profile_id', userId)
    .maybeSingle();
  return (data?.role as Role | undefined) ?? null;
}

export function canRead(role: Role | null): boolean {
  return role !== null;
}

export function canEdit(role: Role | null): boolean {
  return role === 'owner' || role === 'editor';
}

export function canManage(role: Role | null): boolean {
  return role === 'owner';
}
