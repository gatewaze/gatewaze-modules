/**
 * Who gets a speaker kit, decided without touching the database so it can be
 * tested.
 *
 * This exists because of a real incident on 2026-10-11. The event-agenda
 * programme importer created 92 `confirmed` talks for "AGNTCon + MCPCon
 * Europe", an event that had already happened but whose `events` row was
 * mis-dated 2027-09-15. The sweep's only guard was `event_start >= now()`, so
 * it read the event as upcoming and spun up 92 kits: Chromium card renders and
 * an AI post-generation run each. None of those 92 speakers had an avatar, so
 * every card would have rendered with an empty photo frame.
 *
 * Two rules come out of that, and they are deliberately different in kind.
 */

/** A talk the sweep is considering, with its event's dates. */
export interface EligibilityInput {
  talkId: string;
  eventStart: string | null;
  eventEnd: string | null;
  /** Resolved the same way lib/promo/context.ts resolves it: the per-event
   *  participation row's avatar first, then the cross-event profile's. */
  avatarUrl: string | null;
}

export type IneligibleReason = 'event_finished' | 'event_too_far_out' | 'no_avatar' | 'no_event_date';

/**
 * How far ahead of an event a kit is worth building.
 *
 * A promo kit is an announcement asset. More than a year before the event it
 * is not early, it is wrong: the talk title, the speaker's job and the
 * branding will all have moved by the time anyone posts it.
 *
 * This is a product rule on its own terms, and it is NOT what protects
 * against the incident above. The mis-dated row said 2027-09-15, which from
 * 2026-10-11 is about 339 days out and therefore inside this horizon. I
 * expected it to catch the case, wrote a test asserting so, and the test
 * proved otherwise. Shortening the horizon to catch it would block the
 * legitimate case of a conference announcing speakers eight months ahead,
 * which is normal. So the avatar rule is the real guard, and no amount of
 * date arithmetic identifies a past event when the stored date says future.
 */
export const DEFAULT_HORIZON_DAYS = 365;

export interface EligibilityOptions {
  now?: Date;
  horizonDays?: number;
}

/**
 * Null when the talk should get a kit, otherwise why not.
 *
 * Checked in order of cost to the reader: an event that is over or absurdly
 * far out is a scheduling fact, while a missing avatar is something a human
 * can fix by uploading a photo.
 */
export function kitIneligibleReason(
  input: EligibilityInput,
  opts: EligibilityOptions = {},
): IneligibleReason | null {
  const now = opts.now ?? new Date();
  const horizonDays = Number.isFinite(opts.horizonDays) ? Number(opts.horizonDays) : DEFAULT_HORIZON_DAYS;

  const start = Date.parse(input.eventStart ?? '');
  const end = Date.parse(input.eventEnd ?? '');

  // No usable date at all. Fail closed: the whole point of this gate is that
  // we stopped being able to trust the date, so an absent one is not a reason
  // to proceed.
  if (!Number.isFinite(start) && !Number.isFinite(end)) return 'no_event_date';

  // Prefer the END date for "is it over". An event mid-flight should still be
  // promotable on its second morning, which `event_start >= now()` denied.
  const finishesAt = Number.isFinite(end) ? end : start;
  if (finishesAt < now.getTime()) return 'event_finished';

  if (Number.isFinite(start) && horizonDays > 0) {
    const horizon = now.getTime() + horizonDays * 86_400_000;
    if (start > horizon) return 'event_too_far_out';
  }

  // The card renders the speaker's photo. Without one it renders an empty
  // frame, which is worse than no kit: it looks finished and is not.
  if (!input.avatarUrl || !String(input.avatarUrl).trim()) return 'no_avatar';

  return null;
}

/** The talks worth creating kit rows for, and a count per rejection reason. */
export function partitionEligible(
  inputs: EligibilityInput[],
  opts: EligibilityOptions = {},
): { eligible: EligibilityInput[]; skipped: Record<IneligibleReason, number> } {
  const skipped: Record<IneligibleReason, number> = {
    event_finished: 0,
    event_too_far_out: 0,
    no_avatar: 0,
    no_event_date: 0,
  };
  const eligible: EligibilityInput[] = [];
  for (const input of inputs) {
    const reason = kitIneligibleReason(input, opts);
    if (reason) skipped[reason] += 1;
    else eligible.push(input);
  }
  return { eligible, skipped };
}

/** A one-line summary for the sweep log, omitting reasons that did not fire. */
export function describeSkipped(skipped: Record<IneligibleReason, number>): string {
  const parts = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${reason}`);
  return parts.length ? parts.join(', ') : 'none';
}
