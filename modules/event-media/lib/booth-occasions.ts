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
 * An occasion is a family of looks. Halloween is the party and the
 * costume with face paint; Christmas is the party, Father Christmas and
 * an elf (asked 2026-10-27). Each family member is one look per decade,
 * under an id of `<member>-<era>` (`halloween-1950s`,
 * `halloween-costume-1950s`), so the prompt for a 50s Halloween is
 * written beside every other prompt in lib/booth-effects.ts and goes out
 * wrapped in the same guard rails.
 *
 * Which occasions an event offers is a per-event setting
 * (events_media_booth_settings.occasion, migration 031): none, one of
 * them, or every one. Choosing an occasion offers its whole family.
 */

export interface BoothOccasion {
  key: string;
  label: string;
  /** One line for the admin's setting. */
  blurb: string;
  /**
   * The family, as look-id prefixes in board order. The first is the
   * occasion itself; the rest are its costumes.
   */
  looks: readonly string[];
}

export const BOOTH_OCCASIONS: readonly BoothOccasion[] = [
  {
    key: 'halloween', label: 'Halloween', blurb: 'Pumpkins, cobwebs and costumes, in every decade',
    looks: ['halloween', 'halloween-costume'],
  },
  {
    key: 'christmas', label: 'Christmas', blurb: 'Tinsel, trees, Father Christmas and elves, in every decade',
    looks: ['christmas', 'christmas-santa', 'christmas-elf'],
  },
];

const OCCASION_KEYS = new Set(BOOTH_OCCASIONS.map((o) => o.key));
/** Every look prefix, and the occasion it belongs to. */
const PREFIX_OCCASION = new Map(BOOTH_OCCASIONS.flatMap((o) => o.looks.map((p) => [p, o.key] as const)));

/** The look id for a family member in an era: `halloween-costume-1950s`. */
export function occasionLookId(prefix: string, era: string): string {
  return `${prefix}-${era}`;
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

/** The occasion look ids an era's board carries under a setting, in family order. */
export function occasionLooks(setting: string | null | undefined, era: string): string[] {
  return occasionsFor(setting).flatMap((o) => o.looks.map((p) => occasionLookId(p, era)));
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
 * Only ids built by `occasionLookId` match: the prefix must be one of
 * a family's and the era must be a decade key.
 */
export function occasionOf(lookId: string): { occasion: string; era: string } | null {
  const m = /^([a-z]+(?:-[a-z]+)*)-([0-9]{4}s)$/.exec(lookId);
  const occasion = m ? PREFIX_OCCASION.get(m[1]!) : undefined;
  return m && occasion ? { occasion, era: m[2]! } : null;
}
