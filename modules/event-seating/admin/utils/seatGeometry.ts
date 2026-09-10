/**
 * Seat positions are derived, never stored. A table row carries its centre,
 * size, rotation, seat count and layout; this module turns that into the
 * concrete seat coordinates used by both the editor and the export.
 *
 * All coordinates are in centimetres with a top-left origin (x right, y down),
 * matching the plan's canvas_width / canvas_height — so the plan is drawn at
 * the room's real scale.
 */

import type { SeatingTable } from './seatingService';

/**
 * Gap between the table edge and the centre of a seat, in centimetres —
 * roughly where a seated guest's chair sits.
 */
export const SEAT_GAP = 26;
/** Diameter of a seat marker, in centimetres. */
export const SEAT_SIZE = 34;

export interface SeatPoint {
  /** Geometric index. Stable when neighbouring seats are blocked. */
  index: number;
  x: number;
  y: number;
  /** Direction the seated guest faces, degrees clockwise from "up". */
  facing: number;
}

export interface UsableSeat extends SeatPoint {
  /**
   * 1-based position among the seats actually in use, in geometric order.
   * This is what guests and the venue see, so blocking a seat closes the gap
   * in the numbering rather than leaving a hole.
   */
  displayNumber: number;
}

function rotatePoint(x: number, y: number, cx: number, cy: number, degrees: number) {
  if (!degrees) return { x, y };
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = x - cx;
  const dy = y - cy;
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

/** Evenly spaced offsets along a run of `length`, inset from both ends. */
function spread(count: number, length: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const step = length / count;
  return Array.from({ length: count }, (_, i) => -length / 2 + step * (i + 0.5));
}

function roundSeats(table: SeatingTable): SeatPoint[] {
  const radius = table.width / 2 + SEAT_GAP;
  const n = table.seat_count;
  return Array.from({ length: n }, (_, i) => {
    // Seat 0 sits at the top of the table and numbering runs clockwise,
    // which is how people read a printed plan.
    const angle = (-90 + (360 / n) * i) * (Math.PI / 180);
    return {
      index: i,
      x: table.x + Math.cos(angle) * radius,
      y: table.y + Math.sin(angle) * radius,
      facing: (180 + (360 / n) * i) % 360,
    };
  });
}

function rectSeats(table: SeatingTable): SeatPoint[] {
  const n = table.seat_count;
  const halfW = table.width / 2;
  const halfH = table.height / 2;
  const points: Array<{ x: number; y: number; facing: number }> = [];

  if (table.seat_layout === 'one_side') {
    // Top table: everyone along the far side, facing the room.
    for (const dx of spread(n, table.width)) {
      points.push({ x: table.x + dx, y: table.y - halfH - SEAT_GAP, facing: 180 });
    }
  } else if (table.seat_layout === 'around') {
    // Distribute proportionally to edge length so spacing stays even
    // all the way round, then walk top → right → bottom → left.
    const perimeter = 2 * (table.width + table.height);
    const perTop = Math.max(1, Math.round((n * table.width) / perimeter));
    const perSide = Math.max(1, Math.round((n * table.height) / perimeter));
    let top = perTop;
    let bottom = perTop;
    let left = perSide;
    let right = perSide;
    // Absorb the rounding error on the long edges.
    let drift = n - (top + bottom + left + right);
    while (drift !== 0) {
      const bump = drift > 0 ? 1 : -1;
      if (table.width >= table.height) {
        top += bump;
        drift -= bump;
        if (drift !== 0) { bottom += bump; drift -= bump; }
      } else {
        right += bump;
        drift -= bump;
        if (drift !== 0) { left += bump; drift -= bump; }
      }
      top = Math.max(0, top); bottom = Math.max(0, bottom);
      left = Math.max(0, left); right = Math.max(0, right);
    }
    for (const dx of spread(top, table.width)) {
      points.push({ x: table.x + dx, y: table.y - halfH - SEAT_GAP, facing: 180 });
    }
    for (const dy of spread(right, table.height)) {
      points.push({ x: table.x + halfW + SEAT_GAP, y: table.y + dy, facing: 270 });
    }
    for (const dx of spread(bottom, table.width).reverse()) {
      points.push({ x: table.x + dx, y: table.y + halfH + SEAT_GAP, facing: 0 });
    }
    for (const dy of spread(left, table.height).reverse()) {
      points.push({ x: table.x - halfW - SEAT_GAP, y: table.y + dy, facing: 90 });
    }
  } else if (table.seat_layout === 'sides_balanced') {
    // Equal numbers down both long sides so guests sit directly opposite one
    // another, with an odd one out at the far end. A 9-seat table reads
    // 4 / 4 / 1 rather than 'around'\'s 4 / 3 with both ends used, where
    // nobody lines up.
    const perSide = Math.floor(n / 2);
    const odd = n - perSide * 2; // 0 or 1
    const offsets = spread(perSide, table.width);
    for (const dx of offsets) {
      points.push({ x: table.x + dx, y: table.y - halfH - SEAT_GAP, facing: 180 });
    }
    if (odd) {
      points.push({ x: table.x + halfW + SEAT_GAP, y: table.y, facing: 270 });
    }
    // Reversed so numbering runs round the table rather than back along it,
    // and so each seat faces the one opposite.
    for (const dx of [...offsets].reverse()) {
      points.push({ x: table.x + dx, y: table.y + halfH + SEAT_GAP, facing: 0 });
    }
  } else {
    // 'both_sides' — banquet style, nobody on the ends.
    const top = Math.ceil(n / 2);
    const bottom = n - top;
    for (const dx of spread(top, table.width)) {
      points.push({ x: table.x + dx, y: table.y - halfH - SEAT_GAP, facing: 180 });
    }
    for (const dx of spread(bottom, table.width).reverse()) {
      points.push({ x: table.x + dx, y: table.y + halfH + SEAT_GAP, facing: 0 });
    }
  }

  return points.slice(0, n).map((p, i) => {
    const r = rotatePoint(p.x, p.y, table.x, table.y, table.rotation);
    return { index: i, x: r.x, y: r.y, facing: (p.facing + table.rotation) % 360 };
  });
}

/** Seat coordinates for one table, ordered by seat_index. */
export function seatPositions(table: SeatingTable): SeatPoint[] {
  if (table.seat_count <= 0) return [];
  if (table.shape === 'round') {
    // A round table's seats are rotationally symmetric, but honouring
    // `rotation` still lets you line seat 1 up with a real-world landmark.
    return roundSeats(table).map((s) => {
      const r = rotatePoint(s.x, s.y, table.x, table.y, table.rotation);
      return { ...s, x: r.x, y: r.y, facing: (s.facing + table.rotation) % 360 };
    });
  }
  return rectSeats(table);
}

/** Is this seat index out of use on this table? */
export function isSeatBlocked(table: SeatingTable, index: number): boolean {
  return (table.disabled_seats || []).includes(index);
}

/**
 * The seats a guest can actually sit in, numbered consecutively. Everything
 * user-facing — the canvas, the roster, the exports — works from this, so a
 * table pushed against another simply has fewer seats rather than gaps.
 */
export function usableSeats(table: SeatingTable): UsableSeat[] {
  const blocked = table.disabled_seats || [];
  const out: UsableSeat[] = [];
  for (const seat of seatPositions(table)) {
    if (blocked.includes(seat.index)) continue;
    out.push({ ...seat, displayNumber: out.length + 1 });
  }
  return out;
}

/** How many people this table can actually take. */
export function usableSeatCount(table: SeatingTable): number {
  const blocked = table.disabled_seats || [];
  let n = 0;
  for (let i = 0; i < table.seat_count; i++) if (!blocked.includes(i)) n++;
  return n;
}

/** Bounding box of a table including its seats — used to keep drags in-canvas. */
export function tableBounds(table: SeatingTable) {
  const pad = SEAT_GAP + SEAT_SIZE / 2;
  const halfW = (table.shape === 'round' ? table.width : table.width) / 2 + pad;
  const halfH = (table.shape === 'round' ? table.width : table.height) / 2 + pad;
  return {
    left: table.x - halfW,
    top: table.y - halfH,
    right: table.x + halfW,
    bottom: table.y + halfH,
  };
}

/**
 * Nearest seat to a point, within `maxDistance` canvas units.
 * Used to resolve where a dragged guest was dropped.
 */
export function findSeatNear(
  tables: SeatingTable[],
  x: number,
  y: number,
  maxDistance = SEAT_SIZE,
): { tableId: string; seatIndex: number } | null {
  let best: { tableId: string; seatIndex: number } | null = null;
  let bestDistance = maxDistance;
  for (const table of tables) {
    // Blocked seats are not drop targets — a dragged guest passes over them.
    for (const seat of usableSeats(table)) {
      const distance = Math.hypot(seat.x - x, seat.y - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { tableId: table.id, seatIndex: seat.index };
      }
    }
  }
  return best;
}

/** Snap a value to the plan grid; `grid` of 0 disables snapping. */
export function snap(value: number, grid: number): number {
  if (!grid || grid <= 0) return value;
  return Math.round(value / grid) * grid;
}
