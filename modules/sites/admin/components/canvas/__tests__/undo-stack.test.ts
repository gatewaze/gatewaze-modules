// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it } from 'vitest';
import { UndoStack, deriveInverse, labelForOp } from '../undo-stack.js';
import type { CanvasOp } from '../../../../lib/canvas-render/types.js';

const UUID = '11111111-1111-1111-1111-111111111111';

function entry(forward: CanvasOp, inverse: CanvasOp | null = null) {
  return { forward, inverse, label: labelForOp(forward) };
}

describe('UndoStack — basic semantics', () => {
  it('starts empty', () => {
    const s = new UndoStack();
    expect(s.size()).toBe(0);
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
  });

  it('pushes an entry and enables undo (when inverse present)', () => {
    const s = new UndoStack();
    const fwd: CanvasOp = { kind: 'block.update_field', blockId: UUID, fieldPath: 'title', newValue: 'A' };
    const inv: CanvasOp = { kind: 'block.update_field', blockId: UUID, fieldPath: 'title', newValue: '' };
    s.push(entry(fwd, inv));
    expect(s.size()).toBe(1);
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(false);
  });

  it('disables undo when entry has no inverse', () => {
    const s = new UndoStack();
    const fwd: CanvasOp = { kind: 'block.delete', blockId: UUID };
    s.push(entry(fwd, null));
    expect(s.canUndo()).toBe(false);
  });

  it('undo returns inverse op then enables redo', () => {
    const s = new UndoStack();
    const fwd: CanvasOp = { kind: 'block.update_field', blockId: UUID, fieldPath: 'x', newValue: 'b' };
    const inv: CanvasOp = { kind: 'block.update_field', blockId: UUID, fieldPath: 'x', newValue: 'a' };
    s.push(entry(fwd, inv));
    const u = s.undo();
    expect(u).toEqual(inv);
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(true);
  });

  it('redo returns the original forward op', () => {
    const s = new UndoStack();
    const fwd: CanvasOp = { kind: 'block.update_field', blockId: UUID, fieldPath: 'x', newValue: 'b' };
    const inv: CanvasOp = { kind: 'block.update_field', blockId: UUID, fieldPath: 'x', newValue: 'a' };
    s.push(entry(fwd, inv));
    s.undo();
    const r = s.redo();
    expect(r).toEqual(fwd);
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(false);
  });

  it('truncates the redo tail when a new entry is pushed', () => {
    const s = new UndoStack();
    const a: CanvasOp = { kind: 'block.update_field', blockId: UUID, fieldPath: 'x', newValue: 'a' };
    const b: CanvasOp = { kind: 'block.update_field', blockId: UUID, fieldPath: 'x', newValue: 'b' };
    s.push(entry(a, a));
    s.push(entry(b, b));
    s.undo();
    expect(s.canRedo()).toBe(true);
    s.push(entry(a, a)); // new push — should drop the redoable b
    expect(s.canRedo()).toBe(false);
    expect(s.size()).toBe(2);
  });

  it('respects capacity by dropping oldest', () => {
    const s = new UndoStack(3);
    const op = (v: string): CanvasOp => ({ kind: 'block.update_field', blockId: UUID, fieldPath: 'x', newValue: v });
    s.push(entry(op('a'), op('a')));
    s.push(entry(op('b'), op('b')));
    s.push(entry(op('c'), op('c')));
    s.push(entry(op('d'), op('d'))); // drops 'a'
    expect(s.size()).toBe(3);
    s.undo(); // d
    s.undo(); // c
    s.undo(); // b
    expect(s.canUndo()).toBe(false); // 'a' was dropped
  });
});

describe('deriveInverse', () => {
  it('inverts block.update_field with the preValue', () => {
    const inv = deriveInverse({
      forward: { kind: 'block.update_field', blockId: UUID, fieldPath: 'title', newValue: 'B' },
      preValue: 'A',
    });
    expect(inv).toEqual({ kind: 'block.update_field', blockId: UUID, fieldPath: 'title', newValue: 'A' });
  });

  it('inverts brick.update_field with the preValue', () => {
    const inv = deriveInverse({
      forward: { kind: 'brick.update_field', brickId: UUID, fieldPath: 'x', newValue: 'B' },
      preValue: 'A',
    });
    expect(inv).toEqual({ kind: 'brick.update_field', brickId: UUID, fieldPath: 'x', newValue: 'A' });
  });

  it('inverts block.set_variant with the preVariantKey', () => {
    const inv = deriveInverse({
      forward: { kind: 'block.set_variant', blockId: UUID, variantKey: 'v2' },
      preVariantKey: 'v1',
    });
    expect(inv).toEqual({ kind: 'block.set_variant', blockId: UUID, variantKey: 'v1' });
  });

  it('returns null for set_variant without preVariantKey', () => {
    expect(deriveInverse({ forward: { kind: 'block.set_variant', blockId: UUID, variantKey: 'v2' } })).toBeNull();
  });

  it('returns null for insert/move/delete (v1 limitation)', () => {
    expect(deriveInverse({ forward: { kind: 'block.insert', afterBlockId: null, parentBrickId: null, blockDefKey: 'hero', content: {} } })).toBeNull();
    expect(deriveInverse({ forward: { kind: 'block.move', blockId: UUID, afterBlockId: null, parentBrickId: null } })).toBeNull();
    expect(deriveInverse({ forward: { kind: 'block.delete', blockId: UUID } })).toBeNull();
  });
});

describe('labelForOp', () => {
  it('produces a human-readable label per op kind', () => {
    expect(labelForOp({ kind: 'block.delete', blockId: UUID })).toBe('Delete block');
    expect(labelForOp({ kind: 'block.update_field', blockId: UUID, fieldPath: 'title', newValue: 'X' })).toBe('Edit title');
    expect(labelForOp({ kind: 'preset.apply', afterBlockId: null, parentBrickId: null, presetId: UUID })).toBe('Apply preset');
  });
});
