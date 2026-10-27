/**
 * The photo booth's occasions: a second axis beside the decades.
 *
 * A decade says when the picture was taken; an occasion says what was
 * being celebrated. The two cross, so a guest in the 1950s booth can
 * have a 50s Halloween picture, and a guest in the 1970s booth a 70s
 * Christmas one. The occasion looks sit on each decade's board beside
 * that decade's ordinary looks -- they are extra choices, not a
 * replacement (asked 2026-10-27).
 *
 * Which occasions an event offers is a per-event setting
 * (events_media_booth_settings.occasion, migration 031): none, one of
 * them, or every one. The looks themselves live in the catalogue
 * (lib/booth-effects.ts) under ids of the form `<occasion>-<era>`, so
 * the prompt for a 50s Halloween is written beside every other prompt
 * and goes out wrapped in the same guard rails.
 */

export interface BoothOccasion {
  key: string;
  label: string;
  /** One line for the admin's setting. */
  blurb: string;
}

export const BOOTH_OCCASIONS: readonly BoothOccasion[] = [
  { key: 'halloween', label: 'Halloween', blurb: 'Pumpkins, cobwebs and costumes, in every decade' },
  { key: 'christmas', label: 'Christmas', blurb: 'Tinsel, trees and paper chains, in every decade' },
];

const OCCASION_KEYS = new Set(BOOTH_OCCASIONS.map((o) => o.key));

/** The look id for an occasion in an era: `halloween-1950s`. */
export function occasionLookId(occasion: string, era: string): string {
  return `${occasion}-${era}`;
}

/**
 * The occasions an event's setting offers: none, one, or all of them.
 * Anything unrecognised means none, which is where every event starts.
 */
export function occasionsFor(setting: string | null | undefined): BoothOccasion[] {
  if (!setting || setting === 'none') return [];
  if (setting === 'all') return [...BOOTH_OCCASIONS];
  const one = BOOTH_OCCASIONS.find((o) => o.key === setting);
  return one ? [one] : [];
}

/** The occasion look ids an era's board carries under a setting, in catalogue order. */
export function occasionLooks(setting: string | null | undefined, era: string): string[] {
  return occasionsFor(setting).map((o) => occasionLookId(o.key, era));
}

/** Every occasion look an era could carry, whatever the setting. */
export function eraOccasionLooks(era: string): string[] {
  return occasionLooks('all', era);
}

export function isOccasionSetting(v: unknown): v is string {
  return v === 'none' || v === 'all' || (typeof v === 'string' && OCCASION_KEYS.has(v));
}

/**
 * Which occasion and era a look id names, or null for an ordinary look.
 * Only ids built by `occasionLookId` match: the occasion must be one of
 * ours and the era must be a decade key.
 */
export function occasionOf(lookId: string): { occasion: string; era: string } | null {
  const m = /^([a-z]+)-([0-9]{4}s)$/.exec(lookId);
  if (!m || !OCCASION_KEYS.has(m[1]!)) return null;
  return { occasion: m[1]!, era: m[2]! };
}
