import type { SeatingTable } from './seatingService';

/**
 * Table presets. Pure geometry with no data access, so the defaults can be
 * exercised directly and the service stays about persistence.
 */

/**
 * Ready-made tables. Rectangles seat guests directly opposite one another,
 * which is what people mean by a "6-person table"; width follows the number
 * per side so the seats keep a sane pitch.
 */
export interface TablePreset {
  id: string;
  label: string;
  group: 'Rectangular — guests opposite' | 'Round' | 'Top table';
  build: (index: number) => Partial<SeatingTable>;
}

/** Centre-to-centre spacing along a table edge, in canvas units. */
const SEAT_PITCH = 95;

function rectPreset(seats: number): Partial<SeatingTable> {
  const perSide = Math.max(1, Math.ceil(seats / 2));
  return {
    shape: 'rect',
    seat_layout: 'sides_balanced',
    seat_count: seats,
    width: Math.max(140, perSide * SEAT_PITCH),
    height: 90,
  };
}

function roundPreset(seats: number): Partial<SeatingTable> {
  // Keep the same arc length per guest, so a 10-seater is visibly bigger.
  const diameter = Math.max(150, Math.round((seats * SEAT_PITCH) / Math.PI));
  return { shape: 'round', seat_layout: 'around', seat_count: seats, width: diameter, height: diameter };
}

export const TABLE_PRESETS: TablePreset[] = [
  ...[2, 4, 6, 8, 10, 12].map((n) => ({
    id: `rect:${n}`,
    label: `${n} people`,
    group: 'Rectangular — guests opposite' as const,
    build: (index: number) => ({ ...rectPreset(n), label: `Table ${index}` }),
  })),
  ...[6, 8, 10, 12].map((n) => ({
    id: `round:${n}`,
    label: `${n} people`,
    group: 'Round' as const,
    build: (index: number) => ({ ...roundPreset(n), label: `Table ${index}` }),
  })),
  ...[4, 6, 8, 10].map((n) => ({
    id: `head:${n}`,
    label: `${n} along one side`,
    group: 'Top table' as const,
    build: () => ({
      shape: 'rect' as const,
      seat_layout: 'one_side' as const,
      seat_count: n,
      width: Math.max(240, n * SEAT_PITCH),
      height: 90,
      label: 'Top table',
    }),
  })),
];
