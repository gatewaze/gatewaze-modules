/**
 * The photo booth's eras, and the six looks each one offers.
 *
 * The booth runs as: pick an era, see that era's booth from outside with
 * a board of six looks, pick one, step inside and have the photo taken.
 * An event can offer every era or just one ("an 80s party"), which skips
 * the era picker entirely.
 *
 * The looks live here in code, beside their prompts; the artwork for an
 * era -- its interior, and optionally a painted outside board -- lives in
 * the event's booth theme (lib/booth-theme.ts), because it is the
 * event's to choose.
 */

import { boothEffect } from './booth-effects.js';

export interface BoothEra {
  key: string;
  label: string;
  /** One line for the era picker. */
  blurb: string;
  /** Six effect ids from the catalogue, in board order. */
  looks: string[];
}

export const BOOTH_ERAS: BoothEra[] = [
  {
    key: '1950s', label: '1950s', blurb: 'Diners, sock hops and silver-screen glamour',
    looks: ['decade-1950s', 'fifties-sockhop', 'fifties-hollywood', 'fifties-drivein', 'fifties-rocknroll', 'fifties-atomic'],
  },
  {
    key: '1960s', label: '1960s', blurb: 'Mod, spies, space and the summer of love',
    looks: ['decade-1960s', 'sixties-spy', 'sixties-beat', 'sixties-space', 'sixties-summer-of-love', 'sixties-beach'],
  },
  {
    key: '1970s', label: '1970s', blurb: 'Disco, glam rock and roller rinks',
    looks: ['decade-1970s', 'seventies-disco', 'seventies-glam', 'seventies-cop', 'seventies-roller', 'seventies-studio'],
  },
  {
    key: '1980s', label: '1980s', blurb: 'Big hair, neon and movie posters',
    looks: ['eighties-portrait', 'top-gun', 'prom-1985', 'vhs-box', 'dance-movie', 'synthwave'],
  },
  {
    key: '1990s', label: '1990s', blurb: 'Sitcoms, grunge, raves and pop videos',
    looks: ['decade-1990s', 'nineties-sitcom', 'nineties-grunge', 'nineties-popvideo', 'nineties-rave', 'nineties-yearbook'],
  },
  {
    key: '2010s', label: '2010s', blurb: 'Festivals, filters and blockbusters',
    looks: ['decade-2010s', 'tens-hipster', 'tens-blockbuster', 'tens-festival', 'tens-rustic', 'tens-dystopia'],
  },
];

/** The eras an event offers: all of them, or the one it is themed on. */
export function erasFor(setting: string | null | undefined): BoothEra[] {
  if (!setting || setting === 'all') return BOOTH_ERAS;
  const one = BOOTH_ERAS.find((e) => e.key === setting);
  return one ? [one] : BOOTH_ERAS;
}

export function isEraSetting(v: unknown): v is string {
  return v === 'all' || (typeof v === 'string' && BOOTH_ERAS.some((e) => e.key === v));
}

/** Every look an era names must exist in the catalogue as a style. */
export function eraLooksResolve(): string[] {
  const missing: string[] = [];
  for (const era of BOOTH_ERAS) {
    for (const id of era.looks) {
      const e = boothEffect(id);
      if (!e || e.kind !== 'style' || !e.style) missing.push(`${era.key}:${id}`);
    }
  }
  return missing;
}
