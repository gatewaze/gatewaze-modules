/**
 * The schedule-source contract (spec-event-agenda-schedule-import §5.5).
 *
 * A source is three separable pieces: detect (is this page mine, and what do
 * I actually read?), fetch (bytes, so the caller can hash them for the
 * unchanged-skip), and parse (pure, fixture-testable, no I/O). Keeping parse
 * pure is what lets the committed fixtures catch a markup change before a
 * production import does.
 */

export type SessionKind = 'session' | 'break';
export type SessionType = 'talk' | 'keynote' | 'workshop' | 'panel' | 'lightning' | 'fireside';

export interface ParsedSpeaker {
  /**
   * Stable id on the source (sched speaker slug). The per-event idempotency
   * key, and NOT an identity: the slug is derived from the name, is a hex
   * fallback for speakers with no sched account, and one account can appear
   * under two slugs on a single page. Use `sourceUserId` for identity.
   */
  ref: string;
  name: string;
  role: string | null;
  company: string | null;
  bio: string | null;
  avatarUrl: string | null;
  /**
   * The source's own global account id for this person, when the page exposes
   * one. For sched it is the numeric id in the avatar URL, which is stable
   * across events and across name changes, so it is what dedupe matches on.
   */
  sourceUserId: string | null;
}

export interface ParsedSession {
  /** Stable id on the source. For sched this is the ICS UID. */
  ref: string;
  /** Title with the speaker suffix and type prefix removed. */
  title: string;
  /** Exactly as the source gave it, for provenance and debugging. */
  rawTitle: string;
  kind: SessionKind;
  sessionType: SessionType;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  trackRef: string | null;
  description: string | null;
  /** Declared presentation language, when the programme carries one. */
  language: string | null;
  speakers: ParsedSpeaker[];
  sourceUrl: string | null;
}

export interface ParsedSchedule {
  tracks: Array<{ ref: string; name: string }>;
  sessions: ParsedSession[];
  /** Counts the importer surfaces in stats; not every source sets all of them. */
  diagnostics: {
    /** Sessions present in one feed but not the other. */
    skeletonMismatch: number;
    sessionsFromIcs: number;
    sessionsFromHtml: number;
  };
}

/** Raw bytes as fetched, so the caller can hash them. */
export interface RawSchedule {
  kind: string;
  resolvedUrl: string;
  parts: Record<string, string>;
}

/** Fetches a URL with the platform's SSRF + allowlist guarantees applied. */
export type GuardedFetch = (url: string) => Promise<{ ok: boolean; status: number; text: string }>;

export interface ScheduleSource {
  kind: string;
  /**
   * Decide whether this source owns the page, and what URL it will read.
   * `pageHtml` is supplied only when the caller already fetched the page.
   */
  detect(pageUrl: string, pageHtml?: string): { resolvedUrl: string } | null;
  fetch(resolvedUrl: string, get: GuardedFetch): Promise<RawSchedule>;
  parse(raw: RawSchedule): ParsedSchedule;
}
