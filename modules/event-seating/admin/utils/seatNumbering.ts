import type { SeatingTable } from './seatingService';
import { usableSeats, tableBodyBounds } from './seatGeometry';

/**
 * Seat numbers for a whole plan.
 *
 * Numbering per table means a room built from eleven tables has eleven seat
 * 1s. On a meal sheet that is close to useless: "Table, seat 1" identifies
 * nothing, and a room laid out as a U is all one table to the people serving
 * it. Continuous numbering runs 1..N across the plan, so every seat has a
 * number nobody else has and a waiter can find it from the number alone.
 *
 * Per-table numbering stays available, since a room of separate round tables
 * reads perfectly well as "Table 4, seat 3".
 */

export type SeatNumbering = 'continuous' | 'per_table';

/** `${tableId}:${seatIndex}` → the number shown to guests and the venue. */
export type SeatNumberMap = Map<string, number>;

export const seatKey = (tableId: string, seatIndex: number) => `${tableId}:${seatIndex}`;

interface Band {
  top: number;
  bottom: number;
  tables: SeatingTable[];
}

function verticalExtent(table: SeatingTable) {
  const height = table.shape === 'round' ? table.width : table.height;
  return { top: table.y - height / 2, bottom: table.y + height / 2, height };
}

/**
 * Group tables into visual rows.
 *
 * Sorting by y alone would scatter a row whose tables sit at slightly
 * different heights — which is exactly what a U shape looks like, where the
 * tall side tables overlap the row across the top. Tables join a band when
 * they share most of their height with it.
 */
function bandTables(tables: SeatingTable[]): Band[] {
  const sorted = [...tables].sort((a, b) => verticalExtent(a).top - verticalExtent(b).top);
  const bands: Band[] = [];

  for (const table of sorted) {
    const extent = verticalExtent(table);
    const band = bands[bands.length - 1];
    if (band) {
      const overlap = Math.min(band.bottom, extent.bottom) - Math.max(band.top, extent.top);
      const smaller = Math.min(band.bottom - band.top, extent.height);
      if (smaller > 0 && overlap >= smaller * 0.5) {
        band.tables.push(table);
        band.top = Math.min(band.top, extent.top);
        band.bottom = Math.max(band.bottom, extent.bottom);
        continue;
      }
    }
    bands.push({ top: extent.top, bottom: extent.bottom, tables: [table] });
  }

  return bands;
}

/**
 * Tables in the order a person reads the room: top row first, left to right,
 * then the next row down. Ties break on the table's own label and id so the
 * numbering never depends on the order rows came back from the database.
 */
export function tablesInReadingOrder(tables: SeatingTable[]): SeatingTable[] {
  return bandTables(tables).flatMap((band) =>
    [...band.tables].sort((a, b) =>
      (a.x - a.width / 2) - (b.x - b.width / 2)
      || a.label.localeCompare(b.label)
      || a.id.localeCompare(b.id)),
  );
}

/** Tables closer than this are treated as pushed together into one run. */
const JOIN_GAP = 40;

/**
 * Group tables that are pushed together.
 *
 * A U shape, a horseshoe or a long bank is one table to the people serving it,
 * and its seats want numbering as one walk round the outside and back up the
 * inside. Tables standing on their own want their own numbering. Rather than
 * ask which kind of room this is, work it out: anything within a place setting
 * of another table is part of the same run.
 */
export function clusterTables(tables: SeatingTable[], gap = JOIN_GAP): SeatingTable[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id);
    if (!up || up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  for (const t of tables) parent.set(t.id, t.id);

  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tableBodyBounds(tables[i]);
      const b = tableBodyBounds(tables[j]);
      const touching =
        a.left - gap <= b.right && a.right + gap >= b.left &&
        a.top - gap <= b.bottom && a.bottom + gap >= b.top;
      if (touching) union(tables[i].id, tables[j].id);
    }
  }

  const groups = new Map<string, SeatingTable[]>();
  for (const t of tables) {
    const root = find(t.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(t);
  }
  return [...groups.values()];
}

export interface PlacedSeat {
  tableId: string;
  seatIndex: number;
  x: number;
  y: number;
}

/**
 * Seats of one run of joined tables, in the order someone serving would walk
 * them: round the outside, then back along the inside the other way.
 *
 * Seats are ordered by how far along the run's outline they sit, not by their
 * angle from its middle. Angle is a poor stand-in once the arms of a U have
 * any thickness: a seat on the end of an arm and one on its face can sit at
 * much the same angle, and the numbering then hops between them instead of
 * running up the arm.
 *
 * The walk begins at the opening. The widest stretch of outline with no seats
 * on it is the mouth of a U — or the door side of a ring — so starting just
 * past it and going clockwise runs up one arm, across the top and down the
 * other. The inside is the same circuit reversed, which returns up the far arm
 * and back along the near one.
 */
export function orderSeatsInCluster(cluster: SeatingTable[]): PlacedSeat[] {
  const seats: PlacedSeat[] = cluster.flatMap((table) =>
    usableSeats(table).map((s) => ({ tableId: table.id, seatIndex: s.index, x: s.x, y: s.y })));
  if (seats.length === 0) return [];

  // A table on its own already numbers from the top, clockwise; leave it be.
  if (cluster.length === 1) return seats;

  const tableBounds = cluster.map(tableBodyBounds);
  const clusterCentre = {
    x: (Math.min(...tableBounds.map((b) => b.left)) + Math.max(...tableBounds.map((b) => b.right))) / 2,
    y: (Math.min(...tableBounds.map((b) => b.top)) + Math.max(...tableBounds.map((b) => b.bottom))) / 2,
  };

  const outside: PlacedSeat[] = [];
  const inside: PlacedSeat[] = [];
  for (const seat of seats) {
    const table = cluster.find((t) => t.id === seat.tableId)!;
    const seatOut = Math.hypot(seat.x - clusterCentre.x, seat.y - clusterCentre.y);
    const tableOut = Math.hypot(table.x - clusterCentre.x, table.y - clusterCentre.y);
    (seatOut >= tableOut ? outside : inside).push(seat);
  }

  /**
   * Walk one ring of seats. The outline is taken from the ring's own extent:
   * the inside seats of a U trace a smaller rectangle than its outside ones,
   * and measuring them against the outer edge would project a seat in the
   * middle of the top run onto the side of the room.
   */
  const walkFromOpening = (group: PlacedSeat[]): PlacedSeat[] => {
    if (group.length <= 1) return group;

    const box = {
      left: Math.min(...group.map((s) => s.x)),
      right: Math.max(...group.map((s) => s.x)),
      top: Math.min(...group.map((s) => s.y)),
      bottom: Math.max(...group.map((s) => s.y)),
    };
    const width = Math.max(1, box.right - box.left);
    const height = Math.max(1, box.bottom - box.top);
    const perimeter = 2 * (width + height);

    // Distance clockwise around that outline from its bottom-left corner,
    // going up the left side first. Screen coordinates run y downwards, so
    // that is clockwise as it looks on the plan.
    const arc = (s: PlacedSeat): number => {
      const toLeft = s.x - box.left;
      const toRight = box.right - s.x;
      const toTop = s.y - box.top;
      const toBottom = box.bottom - s.y;
      const nearest = Math.min(toLeft, toRight, toTop, toBottom);
      if (nearest === toLeft) return box.bottom - s.y;
      if (nearest === toTop) return height + (s.x - box.left);
      if (nearest === toRight) return height + width + (s.y - box.top);
      return 2 * height + width + (box.right - s.x);
    };

    const sorted = [...group].sort((a, b) => arc(a) - arc(b));
    let gapAt = sorted.length - 1;
    let widest = perimeter - arc(sorted[sorted.length - 1]) + arc(sorted[0]);
    for (let i = 0; i < sorted.length - 1; i++) {
      const span = arc(sorted[i + 1]) - arc(sorted[i]);
      if (span > widest) { widest = span; gapAt = i; }
    }
    return [...sorted.slice(gapAt + 1), ...sorted.slice(0, gapAt + 1)];
  };

  return [...walkFromOpening(outside), ...walkFromOpening(inside).reverse()];
}

/**
 * The number for every seat in use across the plan. Blocked seats are skipped,
 * so the sequence has no gaps and the last number is the number of places laid.
 */
export function planSeatNumbers(
  tables: SeatingTable[],
  mode: SeatNumbering = 'continuous',
): SeatNumberMap {
  const numbers: SeatNumberMap = new Map();

  if (mode === 'per_table') {
    for (const table of tables) {
      for (const seat of usableSeats(table)) {
        numbers.set(seatKey(table.id, seat.index), seat.displayNumber);
      }
    }
    return numbers;
  }

  // Runs of joined tables are numbered as one walk; the runs themselves are
  // taken in reading order, so a room of several banks still reads top-down.
  const clusters = clusterTables(tables);
  const ordered = [...clusters].sort((a, b) => {
    const first = tablesInReadingOrder(tables);
    const rank = (group: SeatingTable[]) =>
      Math.min(...group.map((t) => first.findIndex((f) => f.id === t.id)));
    return rank(a) - rank(b);
  });

  let next = 1;
  for (const cluster of ordered) {
    for (const seat of orderSeatsInCluster(cluster)) {
      numbers.set(seatKey(seat.tableId, seat.seatIndex), next);
      next += 1;
    }
  }
  return numbers;
}

/** The seat numbers on one table, for "seats 12-17" style summaries. */
export function tableSeatRange(
  table: SeatingTable,
  numbers: SeatNumberMap,
): { first: number; last: number } | null {
  const seats = usableSeats(table)
    .map((s) => numbers.get(seatKey(table.id, s.index)))
    .filter((n): n is number => typeof n === 'number');
  if (seats.length === 0) return null;
  return { first: Math.min(...seats), last: Math.max(...seats) };
}
