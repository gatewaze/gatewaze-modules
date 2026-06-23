/**
 * Draggable outline — replaces Puck's click-only outline with a list whose rows
 * can be dragged to reorder the top-level blocks. Wired via `overrides.outline`
 * in CanvasShell.
 *
 * Uses native HTML5 drag-and-drop (no dnd-kit dependency) and Puck's public
 * store: `usePuck()` gives the current `appState.data.content` (the root block
 * array) and `dispatch`. Dropping fires Puck's `reorder` action against the root
 * zone ("root:default-zone"). Clicking a row selects that block on the canvas.
 *
 * Scope: reorders the root content list (the common case for newsletter blocks).
 * Nested zones / slots are not reordered here.
 */

import { useState, type ReactNode } from 'react';
import { usePuck } from '@puckeditor/core';

const ROOT_ZONE = 'root:default-zone';

interface ContentItem {
  type: string;
  props?: { id?: string };
}

function labelFor(type: string): string {
  return type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function DraggableOutline(): ReactNode {
  // usePuck is only valid inside the Puck provider; the outline override always is.
  const puck = usePuck() as unknown as {
    appState?: { data?: { content?: ContentItem[] } };
    dispatch: (action: Record<string, unknown>) => void;
  };
  const content = puck.appState?.data?.content ?? [];
  const dispatch = puck.dispatch;

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  if (content.length === 0) {
    return <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--gray-9, #9ca3af)' }}>No blocks yet.</div>;
  }

  const reset = () => { setDragIndex(null); setOverIndex(null); };

  const drop = (to: number) => {
    if (dragIndex !== null && dragIndex !== to) {
      dispatch({ type: 'reorder', sourceIndex: dragIndex, destinationIndex: to, destinationZone: ROOT_ZONE });
    }
    reset();
  };

  // Best-effort selection (action shape may vary across Puck builds; reorder is
  // the primary feature and uses the stable action above).
  const select = (index: number) => {
    try {
      dispatch({ type: 'setUi', ui: { itemSelector: { index, zone: ROOT_ZONE } } });
    } catch { /* selection is non-critical */ }
  };

  return (
    <div style={{ padding: 6 }} aria-label="Block outline (drag to reorder)">
      {content.map((item, i) => {
        const isDragging = dragIndex === i;
        const isOver = overIndex === i && dragIndex !== null && dragIndex !== i;
        return (
          <div
            key={item.props?.id ?? `${item.type}-${i}`}
            draggable
            onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); setOverIndex(i); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => { e.preventDefault(); drop(i); }}
            onDragEnd={reset}
            onClick={() => select(i)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 8px',
              borderRadius: 6,
              cursor: 'grab',
              fontSize: 13,
              userSelect: 'none',
              color: 'var(--gray-12, #111827)',
              background: isOver ? 'var(--accent-a3, #eef2ff)' : 'transparent',
              opacity: isDragging ? 0.45 : 1,
              boxShadow: isOver
                ? (dragIndex! > i ? 'inset 0 2px 0 var(--accent-9, #6366f1)' : 'inset 0 -2px 0 var(--accent-9, #6366f1)')
                : 'none',
            }}
          >
            <span aria-hidden style={{ color: 'var(--gray-8, #cbd5e1)', fontSize: 14, lineHeight: 1 }}>⠿</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {labelFor(item.type)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
