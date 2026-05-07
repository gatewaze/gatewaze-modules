/**
 * Client-side undo/redo stack for the canvas. Per
 * spec-sites-wysiwyg-builder §5.2.
 *
 * Each user action creates a forward `CanvasOp` plus an inverse op that
 * reverses it. The inverse is computed eagerly, when the action is
 * applied, using the pre-state captured from the rendered tree.
 *
 * Capacity: 100 entries (per spec). On push-past-capacity the oldest
 * entry is dropped.
 *
 * v1 supports inverse derivation for: block.update_field, brick.update_field,
 * block.set_variant. Insert/move/delete inverses require knowing the
 * post-insert id (for delete-after-insert) or the prior position (for
 * move/delete). Phase 2 will extend coverage; for now insert/move/delete
 * push a "non-undoable" entry that breaks the chain.
 */

import type { CanvasOp } from '../../../lib/canvas-render/types.js';

export interface UndoEntry {
  /** The op the user performed (sent to the server). */
  forward: CanvasOp;
  /** The op that reverses it, or null if the action is non-undoable in v1. */
  inverse: CanvasOp | null;
  /** Human-readable label shown in tooltips ("Undo edit field"). */
  label: string;
}

export class UndoStack {
  private stack: UndoEntry[] = [];
  private cursor = -1; // index of the most recently APPLIED entry
  private readonly capacity: number;

  constructor(capacity = 100) {
    this.capacity = capacity;
  }

  /** Append a new entry. Drops any redo entries past the cursor. */
  push(entry: UndoEntry): void {
    // Truncate the redo tail.
    this.stack = this.stack.slice(0, this.cursor + 1);
    this.stack.push(entry);
    if (this.stack.length > this.capacity) {
      this.stack.shift();
    } else {
      this.cursor++;
    }
  }

  /** Whether undo() can do anything. */
  canUndo(): boolean {
    return this.cursor >= 0 && this.stack[this.cursor]?.inverse !== null;
  }

  /** Whether redo() can do anything. */
  canRedo(): boolean {
    return this.cursor < this.stack.length - 1;
  }

  /** Pop the most recent entry and return its inverse op. */
  undo(): CanvasOp | null {
    if (!this.canUndo()) return null;
    const entry = this.stack[this.cursor];
    this.cursor--;
    return entry.inverse!;
  }

  /** Move the cursor forward and return the entry's forward op. */
  redo(): CanvasOp | null {
    if (!this.canRedo()) return null;
    this.cursor++;
    return this.stack[this.cursor].forward;
  }

  size(): number {
    return this.stack.length;
  }

  /** Clear everything. Called on hard reload (version-conflict). */
  clear(): void {
    this.stack = [];
    this.cursor = -1;
  }
}

/**
 * Derive the inverse op for a forward op given the pre-state value at the
 * affected JSONPath (if applicable).
 *
 * v1 covers field updates + variant changes. Returns null when the inverse
 * cannot be derived from the pre-state (e.g. insert/move/delete) — those
 * are still pushed onto the stack but break the chain.
 */
export function deriveInverse(args: {
  forward: CanvasOp;
  /** Pre-apply value at the field path (for *.update_field). */
  preValue?: unknown;
  /** Pre-apply variant_key (for block.set_variant). */
  preVariantKey?: string;
}): CanvasOp | null {
  const { forward } = args;
  switch (forward.kind) {
    case 'block.update_field':
      return {
        kind: 'block.update_field',
        blockId: forward.blockId,
        fieldPath: forward.fieldPath,
        newValue: args.preValue,
      };
    case 'brick.update_field':
      return {
        kind: 'brick.update_field',
        brickId: forward.brickId,
        fieldPath: forward.fieldPath,
        newValue: args.preValue,
      };
    case 'block.set_variant':
      if (typeof args.preVariantKey !== 'string') return null;
      return {
        kind: 'block.set_variant',
        blockId: forward.blockId,
        variantKey: args.preVariantKey,
      };
    default:
      // Insert/move/delete inverses require ids that don't exist yet at
      // queue time. v2 will derive these from the server's response.
      return null;
  }
}

export function labelForOp(op: CanvasOp): string {
  switch (op.kind) {
    case 'block.insert':       return 'Insert block';
    case 'block.move':         return 'Move block';
    case 'block.delete':       return 'Delete block';
    case 'block.update_field': return `Edit ${op.fieldPath}`;
    case 'block.set_variant':  return 'Switch variant';
    case 'brick.insert':       return 'Insert brick';
    case 'brick.move':         return 'Move brick';
    case 'brick.delete':       return 'Delete brick';
    case 'brick.update_field': return `Edit ${op.fieldPath}`;
    case 'preset.apply':       return 'Apply preset';
  }
}
