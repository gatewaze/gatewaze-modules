import { supabase } from '@/lib/supabase';
import type { PlanSnapshot } from './undoStack';
import type { SeatingTable, SeatingAssignment } from './seatingService';

/**
 * Putting a snapshot back.
 *
 * The order is forced by the constraints rather than chosen:
 *
 *  1. Clear the plan's assignments. A seat can only hold one guest and a guest
 *     can only hold one seat, so leaving old rows in place would collide with
 *     the ones going back in. Wiping first also means a guest who moved tables
 *     cannot briefly exist twice.
 *  2. Reconcile the tables. Blocked seats live on the table row, and a trigger
 *     refuses an assignment in a blocked seat — so the tables have to describe
 *     the world the assignments are about to land in.
 *  3. Insert the snapshot's assignments, with their original ids.
 *
 * Ids are ours, so a deleted table and its guests come back as themselves
 * rather than as copies.
 */

/** Only the columns we own; server-managed timestamps are left to the server. */
const TABLE_COLUMNS = [
  'id', 'plan_id', 'label', 'shape', 'seat_layout', 'seat_count', 'disabled_seats',
  'x', 'y', 'width', 'height', 'rotation', 'colour', 'notes', 'sort_order',
] as const;

const ASSIGNMENT_COLUMNS = [
  'id', 'plan_id', 'table_id', 'seat_index', 'party_member_id', 'guest_label', 'notes',
] as const;

function pick<T extends object>(row: T, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of columns) {
    if (key in row) out[key] = (row as Record<string, unknown>)[key];
  }
  return out;
}

export function takeSnapshot(
  tables: SeatingTable[],
  assignments: SeatingAssignment[],
): PlanSnapshot {
  // Copied, not referenced: the live arrays keep being replaced as the board
  // is edited, and a snapshot has to be the state at this instant.
  return {
    tables: tables.map((t) => ({ ...t, disabled_seats: [...t.disabled_seats] })),
    assignments: assignments.map((a) => ({ ...a })),
  };
}

export async function restoreSnapshot(planId: string, snapshot: PlanSnapshot): Promise<void> {
  // 1. Clear assignments.
  const { error: clearError } = await supabase
    .from('seating_assignments')
    .delete()
    .eq('plan_id', planId);
  if (clearError) throw clearError;

  // 2. Tables: drop any that should not exist, then put the rest back as they
  //    were. Deleting a table cascades to nothing now the assignments are gone.
  const { data: liveTables, error: readError } = await supabase
    .from('seating_tables')
    .select('id')
    .eq('plan_id', planId);
  if (readError) throw readError;

  const wanted = new Set(snapshot.tables.map((t) => t.id));
  const strays = (liveTables || []).map((t) => t.id).filter((id) => !wanted.has(id));
  if (strays.length > 0) {
    const { error } = await supabase.from('seating_tables').delete().in('id', strays);
    if (error) throw error;
  }

  if (snapshot.tables.length > 0) {
    const { error } = await supabase
      .from('seating_tables')
      .upsert(snapshot.tables.map((t) => pick(t, TABLE_COLUMNS)), { onConflict: 'id' });
    if (error) throw error;
  }

  // 3. Assignments back, now that the tables agree with them.
  if (snapshot.assignments.length > 0) {
    const { error } = await supabase
      .from('seating_assignments')
      .insert(snapshot.assignments.map((a) => pick(a, ASSIGNMENT_COLUMNS)));
    if (error) throw error;
  }
}
