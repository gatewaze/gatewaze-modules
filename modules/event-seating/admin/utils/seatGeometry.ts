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
/**
 * Minimum space per guest, centre to centre, in centimetres. Below this
 * people are eating elbow to elbow, so a table is not allowed to take more
 * seats than its size supports.
 */
export const MIN_SEAT_SPACING = 60;

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

/**
 * The closest any two seats sit to each other, centre to centre. Measured
 * across every pair rather than just neighbours along an edge, so the corners
 * of an 'around' table — where a side seat meets an end seat — are caught too.
 * Infinity when there is nothing to crowd.
 */
export function minSeatSpacing(table: SeatingTable): number {
  const seats = seatPositions(table);
  let min = Infinity;
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      min = Math.min(min, Math.hypot(seats[i].x - seats[j].x, seats[i].y - seats[j].y));
    }
  }
  return min;
}

/**
 * The most seats this table's size supports at MIN_SEAT_SPACING. Found by
 * adding seats until they crowd, rather than a per-layout formula, so round,
 * banquet and top tables are all judged by the same rule.
 */
export function maxSeatsFor(table: SeatingTable): number {
  let last = 0;
  for (let n = 1; n <= 40; n++) {
    // A tolerance below a centimetre: a 5ft round seating 8 works out at
    // 59.99cm and should not be refused on floating-point dust.
    if (minSeatSpacing({ ...table, seat_count: n }) < MIN_SEAT_SPACING - 0.5) break;
    last = n;
  }
  return last;
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

/** How close two edges must come, in centimetres, before they snap together. */
export const EDGE_SNAP_DISTANCE = 14;

export interface SnapGuide {
  /** 'x' is a vertical line at `position`; 'y' is a horizontal one. */
  axis: 'x' | 'y';
  position: number;
}

export interface SnapResult {
  x: number;
  y: number;
  guides: SnapGuide[];
}

/** Half the extent of a table on each axis, seats excluded. */
function halfExtents(table: Pick<SeatingTable, 'shape' | 'width' | 'height'>) {
  return {
    x: table.width / 2,
    y: (table.shape === 'round' ? table.width : table.height) / 2,
  };
}

/**
 * Candidate centre positions on one axis that leave the moving table aligned
 * with, or butted against, a neighbour. Each carries the coordinate of the
 * line they share, which is what gets drawn as a guide.
 */
function axisCandidates(moving: number, other: number, otherCentre: number) {
  return [
    // Edges flush — the two tables read as one row or one column.
    { at: otherCentre - other + moving, guide: otherCentre - other },
    { at: otherCentre + other - moving, guide: otherCentre + other },
    // Centres in line.
    { at: otherCentre, guide: otherCentre },
    // Butted together, which is how a U shape or a long bank gets built.
    { at: otherCentre - other - moving, guide: otherCentre - other },
    { at: otherCentre + other + moving, guide: otherCentre + other },
  ];
}

/**
 * Pull a dragged table into line with its neighbours.
 *
 * Each axis is resolved independently, so a table can butt against another
 * horizontally while its top edge lines up with a third. The nearest
 * candidate within `threshold` wins; anything further away is left alone so
 * the drag still feels free.
 */
export function snapToNeighbours(
  moving: Pick<SeatingTable, 'id' | 'shape' | 'width' | 'height'>,
  candidate: { x: number; y: number },
  others: SeatingTable[],
  threshold = EDGE_SNAP_DISTANCE,
): SnapResult {
  const half = halfExtents(moving);
  const result: SnapResult = { x: candidate.x, y: candidate.y, guides: [] };

  for (const axis of ['x', 'y'] as const) {
    const movingHalf = half[axis];
    const raw = candidate[axis];
    let best: { at: number; guide: number; distance: number } | null = null;

    for (const other of others) {
      if (other.id === moving.id) continue;
      const otherHalf = halfExtents(other)[axis];
      const otherCentre = axis === 'x' ? other.x : other.y;
      for (const option of axisCandidates(movingHalf, otherHalf, otherCentre)) {
        const distance = Math.abs(option.at - raw);
        if (distance <= threshold && (!best || distance < best.distance)) {
          best = { ...option, distance };
        }
      }
    }

    if (best) {
      result[axis] = best.at;
      result.guides.push({ axis, position: best.guide });
    }
  }

  return result;
}

/** Snap a value to the plan grid; `grid` of 0 disables snapping. */
export function snap(value: number, grid: number): number {
  if (!grid || grid <= 0) return value;
  return Math.round(value / grid) * grid;
}
