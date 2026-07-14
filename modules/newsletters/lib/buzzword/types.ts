/**
 * Shared types for the newsletter buzzword-leaderboard pipeline.
 *
 * A reply email → one or more AI buzzword/phrase submissions → a
 * deterministic leaderboard rendered as a structured-resource section.
 * The LLM (via the newsletter-buzzword-extract recipe) only EXTRACTS;
 * counting and rendering are pure functions here so the tally never
 * depends on the model doing arithmetic.
 */

/** A single extracted phrase in its three canonical forms. */
export interface ExtractedPhrase {
  /** Lowercase counting key; reused across replies for the same concept. */
  canonical: string;
  /** Clean presentation form for the public leaderboard. */
  display: string;
  /** The phrase exactly as the replier wrote it. */
  verbatim: string;
}

/** The recipe's per-reply verdict. Mirrors the recipe response schema. */
export interface ReplyExtraction {
  reply_id: string;
  status: 'extracted' | 'no_phrase' | 'not_a_submission';
  phrases?: ExtractedPhrase[];
  note?: string;
}

/** The recipe's structured `final_output`. */
export interface ExtractionOutput {
  extractions: ReplyExtraction[];
}

/**
 * What we persist onto a processed reply's `metadata.buzzwords` — both as
 * an idempotency marker (so a reply is never dispatched or counted twice)
 * and as the source of truth the leaderboard is tallied from.
 */
export interface ReplyBuzzwordStamp {
  /** 'pending' between dispatch and apply; the recipe status after apply. */
  status: 'pending' | ReplyExtraction['status'];
  /** The recipe run that owns this reply's extraction. */
  run_id: string;
  /** Populated on apply. */
  phrases?: ExtractedPhrase[];
  note?: string;
  applied_at?: string;
}

/** A row on the rendered leaderboard. */
export interface LeaderboardEntry {
  canonical: string;
  display: string;
  count: number;
}

/** The minimal reply shape the pipeline reads from `newsletter_replies`. */
export interface ReplyRow {
  id: string;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  metadata: Record<string, unknown> | null;
}

/** The trimmed, size-bounded reply shape the recipe receives. */
export interface PreparedReply {
  id: string;
  from_name: string;
  subject: string;
  body_text: string;
}
