/**
 * The time window a `discovery_posts` research input covers
 * (spec-content-discovery-and-research-blocks.md §5.2, "Window anchor").
 *
 * The harvest's windows were anchored to the previous RUN with a day's
 * overlap and dedupe removed the repeats. Anchoring to the previous SEND
 * would leave the hours between research and send in no edition at all, so:
 *
 *   lower bound: the previous edition's research run for this block (its
 *                latest completed `edition` run's started_at), else that
 *                edition's send_target_at, else its edition_date at the
 *                cadence hour in the collection timezone
 *   upper bound: now, at run time
 *   exclusions:  every key in the previous edition's research layer for the
 *                same block def, so the overlap repeats nothing
 *
 * The previous edition is the latest in the same collection with a
 * send_target_at earlier than this one's and a completed send, excluding
 * editions marked metadata.special. With no previous edition, fall back to
 * the cadence length, else 8 days (the harvest's default), capped at 21.
 * Pure given the rows; the worker fetches them.
 */

export interface PreviousEditionRow {
  id: string;
  edition_date: string; // YYYY-MM-DD
  send_target_at: string | null;
  /** started_at of its latest completed `edition` research run for the same block def */
  research_started_at: string | null;
  /** keys present in its research layer for the same block def */
  research_keys: string[];
}

export interface WindowInput {
  now: Date;
  previous: PreviousEditionRow | null;
  /** From the collection cadence; days between issues when known. */
  cadenceDays: number | null;
  /** Collection timezone (IANA) and cadence hour for the edition_date fallback. */
  timezone: string | null;
  cadenceHour: number | null;
  /** Explicit `{ days }` window from the binding overrides the anchor. */
  fixedDays?: number | null;
}

export interface ResearchWindow {
  from: string;
  to: string;
  excludeKeys: string[];
  anchor: 'previous_research' | 'previous_send' | 'previous_date' | 'cadence' | 'default' | 'fixed';
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 21;
const DEFAULT_DAYS = 8;

export function computeResearchWindow(input: WindowInput): ResearchWindow {
  const to = input.now.toISOString();
  const cap = new Date(input.now.getTime() - MAX_DAYS * DAY);
  if (input.fixedDays && input.fixedDays > 0) {
    const from = new Date(input.now.getTime() - Math.min(input.fixedDays, 90) * DAY);
    return { from: from.toISOString(), to, excludeKeys: [], anchor: 'fixed' };
  }
  const p = input.previous;
  if (p) {
    let from: Date | null = null;
    let anchor: ResearchWindow['anchor'] = 'previous_research';
    if (p.research_started_at) from = new Date(p.research_started_at);
    else if (p.send_target_at) { from = new Date(p.send_target_at); anchor = 'previous_send'; }
    else { from = dateAtHour(p.edition_date, input.cadenceHour ?? 9, input.timezone ?? 'UTC'); anchor = 'previous_date'; }
    if (from && Number.isFinite(from.getTime())) {
      if (from < cap) from = cap; // a stalled newsletter must not pull a quarter's posts
      return { from: from.toISOString(), to, excludeKeys: p.research_keys ?? [], anchor };
    }
  }
  if (input.cadenceDays && input.cadenceDays > 0) {
    const from = new Date(input.now.getTime() - Math.min(input.cadenceDays + 1, MAX_DAYS) * DAY);
    return { from: from.toISOString(), to, excludeKeys: [], anchor: 'cadence' };
  }
  return { from: new Date(input.now.getTime() - DEFAULT_DAYS * DAY).toISOString(), to, excludeKeys: [], anchor: 'default' };
}

/**
 * `YYYY-MM-DD` at `hour`:00 in `timezone`, as a Date. Uses Intl rather than a
 * tz library (none is baked into the worker image); DST is handled by
 * iterating the offset once.
 */
export function dateAtHour(ymd: string, hour: number, timezone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  // First guess: treat the wall-clock time as UTC, then correct by the zone's offset at that instant.
  const guess = new Date(Date.UTC(y, m - 1, d, hour, 0, 0));
  const offsetMin = tzOffsetMinutes(guess, timezone);
  const corrected = new Date(guess.getTime() - offsetMin * 60_000);
  // A DST boundary between guess and corrected shifts the offset; re-check once.
  const offset2 = tzOffsetMinutes(corrected, timezone);
  return offset2 === offsetMin ? corrected : new Date(guess.getTime() - offset2 * 60_000);
}

/** Minutes east of UTC for `timezone` at `at`. */
export function tzOffsetMinutes(at: Date, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  } catch {
    return 0;
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}
