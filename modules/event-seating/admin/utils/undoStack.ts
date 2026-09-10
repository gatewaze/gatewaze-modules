import type { SeatingTable, SeatingAssignment } from './seatingService';

/**
 * Undo history for a seating plan.
 *
 * Every edit here — moving a bank of tables, blocking a seat, swapping two
 * guests — is several database rows, so undo works from whole-plan snapshots
 * rather than trying to invert each operation. A plan is small (tens of
 * tables, low hundreds of assignments), the snapshots are only held in memory
 * for the session, and restoring one is a bounded reconcile.
 *
 * This module is the state machine only: no data access, so the ordering rules
 * can be tested directly.
 */

export interface PlanSnapshot {
  tables: SeatingTable[];
  assignments: SeatingAssignment[];
}

export interface UndoEntry {
  /** Shown on the button's tooltip: "Undo move table". */
  label: string;
  snapshot: PlanSnapshot;
  /**
   * Rapid edits of the same thing collapse into one step, so typing a table
   * name is a single undo rather than one per keystroke.
   */
  coalesceKey?: string;
  /** When the entry was recorded, for the coalescing window. */
  at: number;
}

export interface UndoState {
  past: UndoEntry[];
  future: UndoEntry[];
}

export const EMPTY_UNDO: UndoState = { past: [], future: [] };

/** Deepest history kept. Snapshots are small, but not free. */
export const MAX_DEPTH = 60;

/** Rapid edits sharing a coalesceKey inside this window become one step. */
export const COALESCE_MS = 1200;

export function canUndo(state: UndoState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: UndoState): boolean {
  return state.future.length > 0;
}

export function undoLabel(state: UndoState): string | null {
  return state.past.length > 0 ? state.past[state.past.length - 1].label : null;
}

export function redoLabel(state: UndoState): string | null {
  return state.future.length > 0 ? state.future[state.future.length - 1].label : null;
}

/**
 * Record the state as it was *before* an edit. Doing a new thing abandons the
 * redo branch, which is what every editor does — the alternative is a tree
 * nobody asked for.
 */
export function recordChange(state: UndoState, entry: UndoEntry): UndoState {
  const previous = state.past[state.past.length - 1];
  const coalesces =
    !!entry.coalesceKey &&
    previous?.coalesceKey === entry.coalesceKey &&
    entry.at - previous.at <= COALESCE_MS;

  if (coalesces) {
    // Keep the older snapshot — it is the state to go back to — but extend the
    // window so a continuing burst stays one step.
    const past = state.past.slice(0, -1);
    past.push({ ...previous, at: entry.at });
    return { past, future: [] };
  }

  const past = [...state.past, entry];
  return {
    past: past.length > MAX_DEPTH ? past.slice(past.length - MAX_DEPTH) : past,
    future: [],
  };
}

export interface StepResult {
  state: UndoState;
  /** The snapshot to put back. */
  restore: PlanSnapshot;
  /** What just happened, for the toast. */
  label: string;
}

/**
 * Step back. `current` is the live state, which becomes the redo entry — the
 * caller supplies it because the live plan is React state, not held here.
 */
export function undo(state: UndoState, current: PlanSnapshot): StepResult | null {
  if (state.past.length === 0) return null;
  const entry = state.past[state.past.length - 1];
  return {
    state: {
      past: state.past.slice(0, -1),
      future: [...state.future, { ...entry, snapshot: current }],
    },
    restore: entry.snapshot,
    label: entry.label,
  };
}

export function redo(state: UndoState, current: PlanSnapshot): StepResult | null {
  if (state.future.length === 0) return null;
  const entry = state.future[state.future.length - 1];
  return {
    state: {
      past: [...state.past, { ...entry, snapshot: current }],
      future: state.future.slice(0, -1),
    },
    restore: entry.snapshot,
    label: entry.label,
  };
}

/**
 * Whether a keypress is an undo or redo request.
 *
 * Skipped inside text fields, where the browser's own undo is what someone
 * pressing Ctrl+Z in a half-typed table name actually wants.
 */
export function undoShortcut(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey'> & { target: EventTarget | null },
): 'undo' | 'redo' | null {
  if (!event.ctrlKey && !event.metaKey) return null;

  const el = event.target as HTMLElement | null;
  if (el) {
    if (typeof el.tagName === 'string' && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return null;
    if (el.isContentEditable) return null;
    if (typeof el.closest === 'function'
        && el.closest('[contenteditable]:not([contenteditable="false"])')) return null;
  }

  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  // Ctrl+Y is the other redo people reach for on Windows.
  if (key === 'y' && !event.metaKey) return 'redo';
  return null;
}
