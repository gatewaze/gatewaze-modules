import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  usableSeats, SEAT_SIZE, snap, findSeatNear, snapToNeighbours,
  rectFromPoints, tablesInRect, type SnapGuide,
} from '../utils/seatGeometry';
import { seatKey, type SeatNumberMap } from '../utils/seatNumbering';
import type { SeatingPlan, SeatingTable, SeatingAssignment } from '../utils/seatingService';

/**
 * The plan surface. Tables and seats are absolutely positioned in canvas units
 * scaled to the available width, following the same overlay-and-transform
 * approach as the invite PDF template editor.
 *
 * Two things can be dragged: a table (moves it and its seats together) and a
 * guest (from the tray or from another seat, dropped onto a seat).
 */

export type DragState =
  | {
      kind: 'table';
      tableId: string;
      grabX: number;
      grabY: number;
      x: number;
      y: number;
      /** Alignment lines to draw while the table is snapped to a neighbour. */
      guides: SnapGuide[];
      /**
       * Everything moving with it, as offsets from the dragged table. Captured
       * at pointer-down so the group keeps its shape however far it travels.
       */
      followers: Array<{ id: string; dx: number; dy: number }>;
    }
  | {
      /** Dragging the canvas itself to move around a zoomed-in plan. */
      kind: 'pan';
      clientX: number;
      clientY: number;
      scrollLeft: number;
      scrollTop: number;
      /** Whether the pointer ever really moved, which separates a pan from a click. */
      moved: boolean;
    }
  | {
      /** Rubber-band selection over empty canvas. */
      kind: 'marquee';
      startX: number;
      startY: number;
      x: number;
      y: number;
      /** Selection to keep when the marquee is additive (shift held). */
      base: string[];
    }
  | {
      kind: 'guest';
      label: string;
      partyMemberId: string | null;
      /** Set when the guest is being moved out of a seat they already hold. */
      assignmentId: string | null;
      clientX: number;
      clientY: number;
      /** Seat currently under the cursor, highlighted as the drop target. */
      target: { tableId: string; seatIndex: number } | null;
    }
  | null;

interface Props {
  plan: SeatingPlan;
  tables: SeatingTable[];
  assignments: SeatingAssignment[];
  namesByAssignment: Map<string, string>;
  backgroundUrl: string | null;
  selectedTableIds: string[];
  /** Seat numbers as the venue will see them. */
  seatNumbers: SeatNumberMap;
  drag: DragState;
  onDragChange: (drag: DragState) => void;
  onSelectTables: (tableIds: string[]) => void;
  onMoveTables: (moves: Array<{ id: string; x: number; y: number }>, commit: boolean) => void;
  onDropGuest: (target: { tableId: string; seatIndex: number } | null) => void;
  onSeatContextMenu: (assignmentId: string) => void;
  /** Take a seat out of use (alt-click). */
  onBlockSeat: (tableId: string, seatIndex: number) => void;
}

export function SeatingCanvas({
  plan,
  tables,
  assignments,
  namesByAssignment,
  backgroundUrl,
  selectedTableIds,
  seatNumbers,
  drag,
  onDragChange,
  onSelectTables,
  onMoveTables,
  onDropGuest,
  onSeatContextMenu,
  onBlockSeat,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);

  // `fitScale` shows the whole plan in the available width; `zoom` multiplies
  // it. At zoom 1 the board looks exactly as it always has; above that the
  // viewport scrolls, which is what makes seat names readable on a full plan.
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const scale = fitScale * zoom;
  scaleRef.current = scale;

  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    // clientWidth excludes the scrollbar, so fit never fights its own bars.
    setFitScale(Math.min(1, el.clientWidth / plan.canvas_width));
  }, [plan.canvas_width]);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  /**
   * Change zoom while keeping the point under the cursor put — without this,
   * zooming walks the plan away from whatever you were looking at.
   */
  const zoomAt = useCallback((nextZoom: number, clientX?: number, clientY?: number) => {
    const clamped = Math.min(4, Math.max(1, nextZoom));
    const el = viewportRef.current;
    setZoom((current) => {
      if (!el || clamped === current) return clamped;
      const rect = el.getBoundingClientRect();
      // Anchor on the cursor, or the viewport centre for button presses.
      const ax = clientX === undefined ? rect.width / 2 : clientX - rect.left;
      const ay = clientY === undefined ? rect.height / 2 : clientY - rect.top;
      const ratio = clamped / current;
      const left = (el.scrollLeft + ax) * ratio - ax;
      const top = (el.scrollTop + ay) * ratio - ay;
      // Scroll after the new size has been laid out.
      requestAnimationFrame(() => {
        el.scrollLeft = left;
        el.scrollTop = top;
      });
      return clamped;
    });
  }, []);

  // Ctrl/Cmd + wheel zooms; a plain wheel scrolls the viewport as normal.
  // Registered non-passively so preventDefault actually suppresses the
  // browser's own page zoom.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY / 240);
      zoomAt(scaleRef.current / fitScale * factor, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, fitScale]);

  /** Pointer position in canvas units. */
  const toCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const current = scaleRef.current || 1;
    return { x: (clientX - rect.left) / current, y: (clientY - rect.top) / current };
  }, []);

  const occupantBySeat = useMemo(() => {
    const map = new Map<string, SeatingAssignment>();
    for (const a of assignments) map.set(`${a.table_id}:${a.seat_index}`, a);
    return map;
  }, [assignments]);

  // ---- drag handling -----------------------------------------------------

  useEffect(() => {
    if (!drag) return;

    const handleMove = (e: PointerEvent) => {
      const point = toCanvasPoint(e.clientX, e.clientY);
      if (drag.kind === 'table') {
        const moving = tables.find((t) => t.id === drag.tableId);
        const rawX = Math.max(0, Math.min(point.x - drag.grabX, plan.canvas_width));
        const rawY = Math.max(0, Math.min(point.y - drag.grabY, plan.canvas_height));

        // Neighbouring edges win over the grid: lining two tables up is the
        // point, and a 20cm grid would fight a 70cm table trying to sit flush
        // against a 180cm one.
        const aligned = plan.snap_to_grid && moving
          ? snapToNeighbours(moving, { x: rawX, y: rawY }, tables)
          : { x: rawX, y: rawY, guides: [] as SnapGuide[] };

        const grid = plan.snap_to_grid ? plan.grid_size : 0;
        const snappedX = aligned.guides.some((g) => g.axis === 'x') ? aligned.x : snap(aligned.x, grid);
        const snappedY = aligned.guides.some((g) => g.axis === 'y') ? aligned.y : snap(aligned.y, grid);

        onDragChange({ ...drag, x: snappedX, y: snappedY, guides: aligned.guides });
        onMoveTables(
          [
            { id: drag.tableId, x: snappedX, y: snappedY },
            ...drag.followers.map((f) => ({
              id: f.id,
              x: Math.max(0, Math.min(snappedX + f.dx, plan.canvas_width)),
              y: Math.max(0, Math.min(snappedY + f.dy, plan.canvas_height)),
            })),
          ],
          false,
        );
      } else if (drag.kind === 'pan') {
        const el = viewportRef.current;
        if (!el) return;
        const dx = e.clientX - drag.clientX;
        const dy = e.clientY - drag.clientY;
        // Deltas are measured against the scroll offset captured at
        // pointer-down, so scrolling as we go cannot feed back on itself.
        el.scrollLeft = drag.scrollLeft - dx;
        el.scrollTop = drag.scrollTop - dy;
        if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
          onDragChange({ ...drag, moved: true });
        }
      } else if (drag.kind === 'marquee') {
        onDragChange({
          ...drag,
          x: Math.max(0, Math.min(point.x, plan.canvas_width)),
          y: Math.max(0, Math.min(point.y, plan.canvas_height)),
        });
      } else {
        const target = findSeatNear(tables, point.x, point.y, SEAT_SIZE * 0.9);
        onDragChange({ ...drag, clientX: e.clientX, clientY: e.clientY, target });
      }
    };

    const handleUp = () => {
      if (drag.kind === 'table') {
        onMoveTables(
          [
            { id: drag.tableId, x: drag.x, y: drag.y },
            ...drag.followers.map((f) => ({
              id: f.id,
              x: Math.max(0, Math.min(drag.x + f.dx, plan.canvas_width)),
              y: Math.max(0, Math.min(drag.y + f.dy, plan.canvas_height)),
            })),
          ],
          true,
        );
        onDragChange(null);
      } else if (drag.kind === 'pan') {
        // A press that never moved is a click on bare canvas, which clears
        // the selection.
        if (!drag.moved) onSelectTables([]);
        onDragChange(null);
      } else if (drag.kind === 'marquee') {
        const rect = rectFromPoints(
          { x: drag.startX, y: drag.startY },
          { x: drag.x, y: drag.y },
        );
        // A marquee that never really moved is a click on empty canvas, which
        // clears the selection rather than selecting nothing in particular.
        const moved = rect.right - rect.left > 3 || rect.bottom - rect.top > 3;
        const caught = moved ? tablesInRect(tables, rect) : [];
        onSelectTables(moved ? [...new Set([...drag.base, ...caught])] : []);
        onDragChange(null);
      } else {
        onDropGuest(drag.target);
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [drag, tables, plan, toCanvasPoint, onDragChange, onMoveTables, onSelectTables, onDropGuest]);

  const startTableDrag = (table: SeatingTable, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Shift adds to or removes from the selection instead of dragging.
    if (e.shiftKey) {
      onSelectTables(
        selectedTableIds.includes(table.id)
          ? selectedTableIds.filter((id) => id !== table.id)
          : [...selectedTableIds, table.id],
      );
      return;
    }

    // Dragging a table that is part of a selection moves the whole selection;
    // dragging any other table selects just that one first.
    const group = selectedTableIds.includes(table.id) ? selectedTableIds : [table.id];
    if (!selectedTableIds.includes(table.id)) onSelectTables([table.id]);

    const followers = tables
      .filter((t) => t.id !== table.id && group.includes(t.id))
      .map((t) => ({ id: t.id, dx: t.x - table.x, dy: t.y - table.y }));

    const point = toCanvasPoint(e.clientX, e.clientY);
    onDragChange({
      kind: 'table',
      tableId: table.id,
      grabX: point.x - table.x,
      grabY: point.y - table.y,
      x: table.x,
      y: table.y,
      guides: [],
      followers,
    });
  };

  const startSeatedGuestDrag = (assignment: SeatingAssignment, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDragChange({
      kind: 'guest',
      label: namesByAssignment.get(assignment.id) || 'Guest',
      partyMemberId: assignment.party_member_id,
      assignmentId: assignment.id,
      clientX: e.clientX,
      clientY: e.clientY,
      target: { tableId: assignment.table_id, seatIndex: assignment.seat_index },
    });
  };

  const gridBackground = plan.grid_size > 0
    ? {
        backgroundImage:
          'linear-gradient(to right, var(--gray-4) 1px, transparent 1px), ' +
          'linear-gradient(to bottom, var(--gray-4) 1px, transparent 1px)',
        backgroundSize: `${plan.grid_size}px ${plan.grid_size}px`,
      }
    : undefined;

  // Viewport height is driven by the fitted plan, not the zoom, so zooming
  // scrolls within a stable frame instead of growing the page.
  const viewportHeight = Math.round(
    Math.min(760, Math.max(360, plan.canvas_height * fitScale)),
  );
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="relative w-full rounded-lg border border-[var(--gray-6)] bg-[var(--color-background)]">
      {/* Zoom controls */}
      <div className="absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] p-0.5 shadow-sm">
        <button
          type="button"
          title="Zoom out"
          disabled={zoom <= 1}
          onClick={() => zoomAt(zoom / 1.25)}
          className="rounded px-2 py-0.5 text-sm text-[var(--gray-11)] hover:bg-[var(--gray-3)] disabled:opacity-40"
        >
          −
        </button>
        <button
          type="button"
          title="Reset to fit"
          onClick={() => zoomAt(1)}
          className="min-w-[46px] rounded px-1 py-0.5 text-xs tabular-nums text-[var(--gray-11)] hover:bg-[var(--gray-3)]"
        >
          {zoomPercent}%
        </button>
        <button
          type="button"
          title="Zoom in"
          disabled={zoom >= 4}
          onClick={() => zoomAt(zoom * 1.25)}
          className="rounded px-2 py-0.5 text-sm text-[var(--gray-11)] hover:bg-[var(--gray-3)] disabled:opacity-40"
        >
          +
        </button>
      </div>

      <div
        ref={viewportRef}
        className="w-full overflow-auto rounded-lg"
        style={{ height: viewportHeight }}
      >
        {/* Sized to the scaled plan so the viewport gets real scroll extents. */}
        <div
          className="relative"
          style={{
            width: Math.round(plan.canvas_width * scale),
            height: Math.round(plan.canvas_height * scale),
          }}
        >
        <div
          ref={surfaceRef}
          className="absolute left-0 top-0 origin-top-left select-none bg-white"
          style={{
            width: plan.canvas_width,
            height: plan.canvas_height,
            transform: `scale(${scale})`,
            cursor: drag?.kind === 'pan' ? 'grabbing' : 'grab',
            ...gridBackground,
          }}
          onPointerDown={(e) => {
            // Presses on a table or seat stop propagation before reaching here,
            // so this is bare canvas. Dragging it moves around the plan, which
            // is what you want most of the time once zoomed in; shift-drag
            // rubber-bands a selection instead, matching shift-click's role of
            // adding to one.
            if (e.button !== 0) return;
            if (e.shiftKey) {
              const point = toCanvasPoint(e.clientX, e.clientY);
              onDragChange({
                kind: 'marquee',
                startX: point.x,
                startY: point.y,
                x: point.x,
                y: point.y,
                base: selectedTableIds,
              });
              return;
            }
            const el = viewportRef.current;
            onDragChange({
              kind: 'pan',
              clientX: e.clientX,
              clientY: e.clientY,
              scrollLeft: el?.scrollLeft ?? 0,
              scrollTop: el?.scrollTop ?? 0,
              moved: false,
            });
          }}
        >
          {backgroundUrl && !plan.background_hidden && (
            <img
              src={backgroundUrl}
              alt=""
              className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-50"
            />
          )}

          {/* Rubber band. */}
          {drag?.kind === 'marquee' && (() => {
            const r = rectFromPoints(
              { x: drag.startX, y: drag.startY },
              { x: drag.x, y: drag.y },
            );
            return (
              <div
                className="pointer-events-none absolute border border-dashed border-[var(--accent-9)] bg-[var(--accent-4)] opacity-60"
                style={{
                  left: r.left, top: r.top,
                  width: r.right - r.left, height: r.bottom - r.top,
                }}
              />
            );
          })()}

          {/* Alignment guides, drawn while a dragged table is snapped. */}
          {drag?.kind === 'table' && drag.guides.map((guide) => (
            <div
              key={`${guide.axis}-${guide.position}`}
              className="pointer-events-none absolute bg-[var(--accent-9)]"
              style={
                guide.axis === 'x'
                  ? { left: guide.position, top: 0, width: 1, height: plan.canvas_height }
                  : { top: guide.position, left: 0, height: 1, width: plan.canvas_width }
              }
            />
          ))}

          {tables.map((table) => {
            const isSelected = selectedTableIds.includes(table.id);
            const seats = usableSeats(table);
            const isRound = table.shape === 'round';
            const width = table.width;
            const height = isRound ? table.width : table.height;

            return (
              <div key={table.id}>
                {/* Table body — dragging this moves the whole table. */}
                <div
                  className={`absolute flex items-center justify-center text-center transition-shadow ${
                    isSelected ? 'ring-2 ring-[var(--accent-9)]' : ''
                  }`}
                  style={{
                    left: table.x - width / 2,
                    top: table.y - height / 2,
                    width,
                    height,
                    borderRadius: isRound ? '50%' : 12,
                    background: table.colour || 'var(--gray-3)',
                    border: '2px solid var(--gray-8)',
                    transform: table.rotation ? `rotate(${table.rotation}deg)` : undefined,
                    cursor: drag?.kind === 'table' && drag.tableId === table.id ? 'grabbing' : 'grab',
                    touchAction: 'none',
                  }}
                  onPointerDown={(e) => startTableDrag(table, e)}
                >
                  <span
                    className="pointer-events-none px-1 text-[15px] font-semibold text-[var(--gray-12)]"
                    style={{ transform: table.rotation ? `rotate(${-table.rotation}deg)` : undefined }}
                  >
                    {table.label}
                  </span>
                </div>

                {/* Seats */}
                {seats.map((seat) => {
                  const assignment = occupantBySeat.get(`${table.id}:${seat.index}`);
                  const name = assignment ? namesByAssignment.get(assignment.id) : undefined;
                  const isDropTarget =
                    drag?.kind === 'guest' &&
                    drag.target?.tableId === table.id &&
                    drag.target.seatIndex === seat.index;
                  const isBeingDragged =
                    drag?.kind === 'guest' && !!assignment && drag.assignmentId === assignment.id;

                  return (
                    <div
                      key={`${table.id}-${seat.index}`}
                      title={
                        name
                          ? `${name} — seat ${seatNumbers.get(seatKey(table.id, seat.index)) ?? seat.displayNumber}`
                          : `Seat ${seatNumbers.get(seatKey(table.id, seat.index)) ?? seat.displayNumber} — alt-click to take it out of use`
                      }
                      className={`absolute flex items-center justify-center rounded-full border text-center ${
                        isDropTarget
                          ? 'border-[var(--accent-9)] bg-[var(--accent-4)] ring-2 ring-[var(--accent-8)]'
                          : assignment
                          ? 'border-[var(--gray-8)] bg-[var(--accent-3)]'
                          : 'border-dashed border-[var(--gray-7)] bg-[var(--color-background)]'
                      }`}
                      style={{
                        left: seat.x - SEAT_SIZE / 2,
                        top: seat.y - SEAT_SIZE / 2,
                        width: SEAT_SIZE,
                        height: SEAT_SIZE,
                        opacity: isBeingDragged ? 0.35 : 1,
                        cursor: assignment ? 'grab' : 'pointer',
                        touchAction: 'none',
                      }}
                      // Dropping is handled once, by the window-level pointerup
                      // above: it resolves the seat under the cursor for every
                      // drop, wherever it lands.
                      onPointerDown={(e) => {
                        // Alt-click takes a seat out of use — the quick way to
                        // clear the edge where another table butts against
                        // this one.
                        if (e.altKey) {
                          e.preventDefault();
                          e.stopPropagation();
                          onBlockSeat(table.id, seat.index);
                          return;
                        }
                        if (assignment) startSeatedGuestDrag(assignment, e);
                        else e.stopPropagation();
                      }}
                      onContextMenu={(e) => {
                        if (!assignment) return;
                        e.preventDefault();
                        onSeatContextMenu(assignment.id);
                      }}
                    >
                      {name ? (
                        <span className="pointer-events-none px-0.5 text-[10px] font-medium leading-tight text-[var(--gray-12)]">
                          {shortName(name)}
                        </span>
                      ) : (
                        <span className="pointer-events-none text-[10px] text-[var(--gray-9)]">
                          {seatNumbers.get(seatKey(table.id, seat.index)) ?? seat.displayNumber}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        </div>
      </div>

      {/* Guest chip following the cursor while dragging. */}
      {drag?.kind === 'guest' && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-[var(--accent-8)] bg-[var(--accent-3)] px-2 py-1 text-xs font-medium text-[var(--gray-12)] shadow-lg"
          style={{ left: drag.clientX + 12, top: drag.clientY + 12 }}
        >
          {drag.label}
        </div>
      )}
    </div>
  );
}

/** Fit a name into a seat chip: first name, plus a surname initial. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 9);
  return `${parts[0].slice(0, 8)} ${parts[parts.length - 1].charAt(0)}`;
}

export default SeatingCanvas;
