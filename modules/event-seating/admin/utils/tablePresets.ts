import type { SeatingTable } from './seatingService';

/**
 * Table presets, in real dimensions.
 *
 * One canvas unit is one centimetre. That makes every stored size meaningful —
 * a table is the size the venue's table actually is, seat markers sit a real
 * distance from the edge, and a plan drawn against a scaled floor plan lines
 * up with the room. Pure geometry with no data access, so the defaults can be
 * exercised directly and the service stays about persistence.
 */

export interface TablePreset {
  id: string;
  label: string;
  group: 'Rectangular — guests opposite' | 'Round' | 'Top table';
  build: (index: number) => Partial<SeatingTable>;
}

/** Centimetres of table edge per guest along a side. */
const SEAT_PITCH_CM = 60;

/**
 * Rectangular and square tables, seating guests directly opposite one another.
 * The first three are the sizes hire companies actually list; the larger ones
 * continue at the same 60cm per guest per side, which is where the 6ft (180cm)
 * six-seater and 8ft (240cm) eight-seater come from.
 */
const RECT_TABLES: Array<{ seats: number; width: number; height: number; note?: string }> = [
  { seats: 2, width: 70, height: 70, note: 'square' },
  { seats: 4, width: 120, height: 75 },
  { seats: 6, width: 180, height: 85 },
  { seats: 8, width: 240, height: 90 },
  { seats: 10, width: 300, height: 90 },
  { seats: 12, width: 360, height: 90 },
];

/** Round banquet tables, at the diameters they are hired in. */
const ROUND_TABLES: Array<{ seats: number; diameter: number; note: string }> = [
  { seats: 6, diameter: 122, note: '4ft' },
  { seats: 8, diameter: 152, note: '5ft' },
  { seats: 10, diameter: 168, note: '5ft 6' },
  { seats: 12, diameter: 183, note: '6ft' },
];

/** Top tables: one row facing the room, at the same pitch per guest. */
const HEAD_TABLE_SEATS = [4, 6, 8, 10];

const size = (w: number, h: number) => `${w} × ${h}cm`;

export const TABLE_PRESETS: TablePreset[] = [
  ...RECT_TABLES.map((t) => ({
    id: `rect:${t.seats}`,
    label: `${t.seats} people · ${size(t.width, t.height)}${t.note ? ` ${t.note}` : ''}`,
    group: 'Rectangular — guests opposite' as const,
    build: (index: number) => ({
      shape: 'rect' as const,
      seat_layout: 'sides_balanced' as const,
      seat_count: t.seats,
      width: t.width,
      height: t.height,
      label: `Table ${index}`,
    }),
  })),
  ...ROUND_TABLES.map((t) => ({
    id: `round:${t.seats}`,
    label: `${t.seats} people · ${t.diameter}cm (${t.note})`,
    group: 'Round' as const,
    build: (index: number) => ({
      shape: 'round' as const,
      seat_layout: 'around' as const,
      seat_count: t.seats,
      width: t.diameter,
      height: t.diameter,
      label: `Table ${index}`,
    }),
  })),
  ...HEAD_TABLE_SEATS.map((seats) => {
    const width = seats * SEAT_PITCH_CM;
    return {
      id: `head:${seats}`,
      label: `${seats} along one side · ${size(width, 90)}`,
      group: 'Top table' as const,
      build: () => ({
        shape: 'rect' as const,
        seat_layout: 'one_side' as const,
        seat_count: seats,
        width,
        height: 90,
        label: 'Top table',
      }),
    };
  }),
];
