/**
 * How long the booth stays open, and how many goes each guest gets.
 *
 * Every picture the booth makes costs real money at a GPU endpoint, and
 * a QR code that has been photographed by a hundred guests does not stop
 * existing when the party does: a link left open is a bill left open
 * (asked 2026-09-28).
 *
 * Two limits, both set per event by the organiser and both off until
 * they are:
 *
 *   closes_hours   the booth stops this many hours after the event
 *                  starts. Guests carried on using it at home for days;
 *                  that was charming for a while and is not free.
 *   max_per_guest  how many pictures one guest may have made. It counts
 *                  what the booth has kept for them, which is every
 *                  picture it has made for that guest whether or not
 *                  they posted it -- a guest who makes ten and posts one
 *                  has still been made ten.
 *
 * The caps in lib/guest-limits.ts are a different thing: those are
 * rate limits, protecting the service from a burst. These are budgets,
 * protecting the organiser from the total.
 */

/** Neither limit applies until an organiser sets it. */
export interface BoothLimits {
  /** Hours after the event starts, or null for "no closing time". */
  closesHours: number | null;
  /** Pictures one guest may have made, or null for "no limit". */
  maxPerGuest: number | null;
}

/** The most an organiser can set, so a typo cannot open it for a year. */
export const MAX_CLOSES_HOURS = 24 * 90;
export const MAX_PER_GUEST = 500;

export function readLimits(row: unknown): BoothLimits {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
  const hours = Number(r['booth_closes_hours']);
  const per = Number(r['booth_max_per_guest']);
  return {
    closesHours: Number.isFinite(hours) && hours > 0 ? Math.min(MAX_CLOSES_HOURS, Math.floor(hours)) : null,
    maxPerGuest: Number.isFinite(per) && per > 0 ? Math.min(MAX_PER_GUEST, Math.floor(per)) : null,
  };
}

/** When the booth closes, or null where it does not. */
export function boothClosesAt(limits: BoothLimits, eventStart: string | null | undefined): number | null {
  if (limits.closesHours === null) return null;
  const start = eventStart ? Date.parse(eventStart) : NaN;
  if (!Number.isFinite(start)) return null;
  return start + limits.closesHours * 3600_000;
}

export type BoothRefusal =
  | { ok: true }
  | { ok: false; code: 'booth_closed'; message: string }
  | { ok: false; code: 'booth_quota'; message: string };

/**
 * Whether this guest may have another picture made.
 *
 * The messages are for guests to read on their own phones, so they say
 * what has happened rather than which rule fired.
 */
export function mayGenerate(opts: {
  limits: BoothLimits;
  eventStart: string | null | undefined;
  now: number;
  /** How many the booth has already made for this guest. */
  made: number;
}): BoothRefusal {
  const closesAt = boothClosesAt(opts.limits, opts.eventStart);
  if (closesAt !== null && opts.now > closesAt) {
    return { ok: false, code: 'booth_closed', message: 'The photo booth has closed. Thank you for coming!' };
  }
  const max = opts.limits.maxPerGuest;
  if (max !== null && opts.made >= max) {
    return {
      ok: false,
      code: 'booth_quota',
      message: `You have had ${max} photo${max === 1 ? '' : 's'} made in the booth, which is all this event allows.`,
    };
  }
  return { ok: true };
}
