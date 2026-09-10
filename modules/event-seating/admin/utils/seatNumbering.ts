import type { SeatingTable } from './seatingService';
import { usableSeats } from './seatGeometry';

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

  let next = 1;
  for (const table of tablesInReadingOrder(tables)) {
    for (const seat of usableSeats(table)) {
      numbers.set(seatKey(table.id, seat.index), next);
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
