/**
 * The pure half of the past-event backfill
 * (spec-event-agenda-schedule-import §6.5).
 *
 * The worker owns the I/O. Everything here is a decision that can be tested
 * without a database: which events are in scope, whether the run should stop
 * for review, and how the cursor advances.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Terminal states, where the worker must not re-enqueue itself. */
export const FINISHED_STATES = ['complete', 'cancelled'] as const;

export type RunState = 'running' | 'paused' | 'complete' | 'cancelled';

export interface BackfillRun {
  id: string;
  state: RunState;
  batch_size: number;
  review_every: number;
  retry_unavailable: boolean;
  force_reimport: boolean;
  cursor_event_start: string | null;
  cursor_event_uuid: string | null;
  processed: number;
}

/** A past conference, as the scope query reads it. */
export interface CandidateEvent {
  id: string;
  event_start: string | null;
  /** The event's own schedule link, from source_details.action_links.schedule. */
  eventScheduleUrl: string | null;
}

/** The per-event import row, for the fields that decide eligibility. */
export interface ImportState {
  status: string | null;
  schedule_url: string | null;
  url_origin: string | null;
  last_success_at: string | null;
}

/**
 * Does this event have a schedule source at all?
 *
 * Mirrors resolveScheduleUrl in workers/import-schedule.ts: a manual URL on
 * the import row wins, otherwise the event's own action link. Anything else
 * has nothing to fetch, so running the importer on it would only write an
 * `unavailable` row we can predict without the round trip.
 */
export function hasScheduleSource(
  event: CandidateEvent,
  imp: ImportState | undefined,
): boolean {
  if (imp?.url_origin === 'manual' && imp.schedule_url) return true;
  return !!event.eventScheduleUrl;
}

export interface ScopeOptions {
  retryUnavailable: boolean;
  forceReimport: boolean;
}

/**
 * Is this event worth an import attempt in this run?
 *
 * The three exclusions, in the order §6.5 argues for them:
 *
 *  - No source. Nothing to fetch.
 *  - Already imported successfully. A backfill is for events that have never
 *    been read; the nightly sweep keeps the recent ones fresh. `forceReimport`
 *    overrides it.
 *  - Already recorded as unavailable. §6.5 is explicit that a dead source for
 *    an old event is the normal outcome, recorded once and not retried.
 *    `retryUnavailable` overrides it, for when a source is known to be back.
 */
export function isInScope(
  event: CandidateEvent,
  imp: ImportState | undefined,
  opts: ScopeOptions,
): boolean {
  if (!hasScheduleSource(event, imp)) return false;
  if (!opts.forceReimport && imp?.last_success_at) return false;
  if (!opts.retryUnavailable && imp?.status === 'unavailable') return false;
  return true;
}

/**
 * The next events to attempt: in scope, not already attempted in this run,
 * oldest first, capped at the batch size.
 *
 * `alreadyProcessed` is the run's own item rows. It is what makes a batch
 * idempotent: re-running a job that already did half its work skips the half
 * it did rather than importing those events twice.
 */
export function selectBatch(
  events: CandidateEvent[],
  importsByEvent: Map<string, ImportState>,
  alreadyProcessed: Set<string>,
  opts: ScopeOptions & { batchSize: number },
): CandidateEvent[] {
  const ordered = [...events].sort(compareByStartThenId);
  const out: CandidateEvent[] = [];
  for (const ev of ordered) {
    if (!UUID_RE.test(String(ev.id ?? ''))) continue;
    if (alreadyProcessed.has(ev.id)) continue;
    if (!isInScope(ev, importsByEvent.get(ev.id), opts)) continue;
    out.push(ev);
    if (out.length >= opts.batchSize) break;
  }
  return out;
}

/**
 * Oldest first, with the id breaking ties so the order is total. An event with
 * no start date sorts last: it is almost certainly a data problem, and it must
 * not sort first and block the cursor.
 */
export function compareByStartThenId(a: CandidateEvent, b: CandidateEvent): number {
  const at = Date.parse(a.event_start ?? '') || Number.MAX_SAFE_INTEGER;
  const bt = Date.parse(b.event_start ?? '') || Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Should the run pause for operator review after this batch?
 *
 * §6.5 asks for the first few events to be reviewed by hand before the run is
 * left unattended. The gate fires when the processed count crosses a multiple
 * of `review_every`, so it keeps firing through a long run rather than only
 * once at the start. `review_every = 0` disables it.
 */
export function shouldPauseForReview(
  processedBefore: number,
  processedAfter: number,
  reviewEvery: number,
): boolean {
  if (!Number.isFinite(reviewEvery) || reviewEvery <= 0) return false;
  if (processedAfter <= processedBefore) return false;
  return Math.floor(processedAfter / reviewEvery) > Math.floor(processedBefore / reviewEvery);
}

/**
 * A validated ISO timestamp for the `event_start >= cursor` scope filter.
 *
 * Re-serialised from a parsed Date rather than passed through, so whatever is
 * on the row cannot reach the query as text. Returns null when it will not
 * parse, which makes the caller scan from the beginning. That is slower and
 * always correct, which is the right way round.
 */
export function cursorFilterValue(run: Pick<BackfillRun, 'cursor_event_start'>): string | null {
  const raw = run?.cursor_event_start;
  if (!raw) return null;
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/** The cursor after a batch: the last event attempted, or the run's current one. */
export function advanceCursor(
  run: Pick<BackfillRun, 'cursor_event_start' | 'cursor_event_uuid'>,
  batch: CandidateEvent[],
): { cursor_event_start: string | null; cursor_event_uuid: string | null } {
  const last = batch.length > 0 ? batch[batch.length - 1] : null;
  if (!last) {
    return {
      cursor_event_start: run.cursor_event_start ?? null,
      cursor_event_uuid: run.cursor_event_uuid ?? null,
    };
  }
  return { cursor_event_start: last.event_start ?? null, cursor_event_uuid: last.id };
}

/** The item row's status column, from an ImportResult status. */
export function itemStatus(status: string | null | undefined): string {
  const s = String(status ?? '');
  return ['complete', 'unavailable', 'failed', 'skipped'].includes(s) ? s : 'errored';
}

/** Which run counter an outcome increments. Only three are counted. */
export function counterFor(status: string): 'complete_count' | 'unavailable_count' | 'failed_count' | null {
  if (status === 'complete') return 'complete_count';
  if (status === 'unavailable') return 'unavailable_count';
  if (status === 'failed' || status === 'errored') return 'failed_count';
  return null;
}

/**
 * The speaker numbers §6.5 wants on the review trail, pulled off the
 * importer's stats blob. Each is a non-negative integer or null, because the
 * blob is written by the importer and read here with no schema between them.
 */
export function reviewCounts(stats: Record<string, unknown> | null | undefined): {
  speakers: number | null;
  speakers_matched_people: number | null;
  unmatched_speakers: number | null;
  sessions: number | null;
} {
  const n = (v: unknown): number | null => {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isInteger(x) && x >= 0 ? x : null;
  };
  const s = stats ?? {};
  return {
    speakers: n(s.speakers),
    speakers_matched_people: n(s.speakers_matched_people),
    unmatched_speakers: n(s.unmatched_speakers),
    sessions: n(s.sessions),
  };
}
