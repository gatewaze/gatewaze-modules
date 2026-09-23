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
  /**
   * Six effect ids from the catalogue, in board order, per place: a
   * decade is not the same thing in Britain as in America, so each
   * country has its own six (asked 2026-09-23).
   */
  looks: { uk: string[]; us: string[] };
}

export const BOOTH_ERAS: BoothEra[] = [
  {
    key: '1940s', label: '1940s', blurb: 'Dance halls, film noir and Technicolor',
    looks: {
      uk: ['decade-1940s', 'forties-noir', 'forties-technicolor', 'forties-swing', 'forties-travel-poster', 'forties-cafe'],
      us: ['us-decade-1940s', 'us-forties-pinup', 'us-forties-silverscreen', 'us-forties-soda', 'us-forties-usostage', 'us-forties-route66'],
    },
  },
  {
    key: '1950s', label: '1950s', blurb: 'Diners, sock hops and silver-screen glamour',
    looks: {
      uk: ['decade-1950s', 'fifties-sockhop', 'fifties-hollywood', 'fifties-drivein', 'fifties-rocknroll', 'fifties-atomic'],
      us: ['us-decade-1950s', 'us-fifties-diner', 'us-fifties-drivein-us', 'us-fifties-rocknroll-us', 'us-fifties-suburbia', 'us-fifties-hotrod'],
    },
  },
  {
    key: '1960s', label: '1960s', blurb: 'Mod, spies, space and the summer of love',
    looks: {
      uk: ['decade-1960s', 'sixties-spy', 'sixties-beat', 'sixties-space', 'sixties-summer-of-love', 'sixties-beach'],
      us: ['us-decade-1960s', 'us-sixties-madison', 'us-sixties-surf', 'us-sixties-motown', 'us-sixties-woodstock', 'us-sixties-cape'],
    },
  },
  {
    key: '1970s', label: '1970s', blurb: 'Disco, glam rock and roller rinks',
    looks: {
      uk: ['decade-1970s', 'seventies-disco', 'seventies-glam', 'seventies-cop', 'seventies-roller', 'seventies-studio'],
      us: ['us-decade-1970s', 'us-seventies-studio', 'us-seventies-van', 'us-seventies-copshow', 'us-seventies-rollerdisco', 'us-seventies-rodeo'],
    },
  },
  {
    key: '1980s', label: '1980s', blurb: 'Big hair, neon and movie posters',
    looks: {
      uk: ['eighties-portrait', 'top-gun', 'prom-1985', 'vhs-box', 'dance-movie', 'synthwave'],
      us: ['us-decade-1980s', 'us-eighties-mall', 'us-eighties-miami', 'us-eighties-prom', 'us-eighties-aerobics', 'us-eighties-arcade'],
    },
  },
  {
    key: '1990s', label: '1990s', blurb: 'Sitcoms, grunge, raves and pop videos',
    looks: {
      uk: ['decade-1990s', 'nineties-sitcom', 'nineties-grunge', 'nineties-popvideo', 'nineties-rave', 'nineties-yearbook'],
      us: ['us-decade-1990s', 'us-nineties-sitcom-us', 'us-nineties-seattle', 'us-nineties-hiphop', 'us-nineties-yearbook-us', 'us-nineties-camp'],
    },
  },
  {
    key: '2000s', label: '2000s', blurb: 'Digicams, pop stars and red carpets',
    looks: {
      uk: ['decade-2000s', 'noughties-popstar', 'noughties-teen-movie', 'noughties-red-carpet', 'noughties-club', 'noughties-webcam'],
      us: ['us-decade-2000s', 'us-noughties-mtv', 'us-noughties-teenpop', 'us-noughties-redcarpet-us', 'us-noughties-teenmovie', 'us-noughties-webcam-us'],
    },
  },
  {
    key: '2010s', label: '2010s', blurb: 'Festivals, filters and blockbusters',
    looks: {
      uk: ['decade-2010s', 'tens-hipster', 'tens-blockbuster', 'tens-festival', 'tens-rustic', 'tens-dystopia'],
      us: ['us-decade-2010s', 'us-tens-coachella', 'us-tens-brooklyn', 'us-tens-superhero', 'us-tens-bigsur', 'us-tens-brunch'],
    },
  },
  {
    key: '2020s', label: '2020s', blurb: 'Portrait mode, neon cities and film revival',
    looks: {
      uk: ['decade-2020s', 'twenties-neon-city', 'twenties-film-camera', 'twenties-prestige-drama', 'twenties-streetwear', 'twenties-garden-party'],
      us: ['us-decade-2020s', 'us-twenties-rooftop', 'us-twenties-film', 'us-twenties-prestige', 'us-twenties-street', 'us-twenties-desert'],
    },
  },
];

/** The six looks an era offers in a place, British if unknown. */
export function eraLooks(era: BoothEra, place: string | null | undefined): string[] {
  return place === 'us' ? era.looks.us : era.looks.uk;
}

/** Every look an era can offer, in either place. */
export function eraAllLooks(era: BoothEra): string[] {
  return [...new Set([...era.looks.uk, ...era.looks.us])];
}

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
    for (const id of eraAllLooks(era)) {
      const e = boothEffect(id);
      if (!e || e.kind !== 'style' || !e.style) missing.push(`${era.key}:${id}`);
    }
  }
  return missing;
}
