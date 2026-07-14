/**
 * Turn raw `newsletter_replies` rows into the compact, size-bounded shape
 * the buzzword-extract recipe receives.
 *
 * Two hard limits force this trimming (both found the hard way — see
 * spec / the buzzword-leaderboard notes):
 *   1. The Goose runner passes each recipe param as one `--params k=v`
 *      CLI arg. Linux caps a single argv string at MAX_ARG_STRLEN=128KB,
 *      so a batch of full reply bodies (each carrying the entire quoted
 *      newsletter thread) overflows argv → `spawn E2BIG`.
 *   2. The Anthropic provider caps output at ~4096 tokens/turn, so too
 *      many replies per run truncates the structured `final_output` and
 *      Goose nag-loops. Hence small BATCH_SIZE below.
 *
 * The buzzword is almost always the first line of a reply, so cutting at
 * the quoted-thread marker and capping length keeps every submission
 * while shrinking a ~1.5MB batch to ~10KB.
 */

import type { PreparedReply, ReplyRow } from './types.js';

export const DEFAULT_BATCH_SIZE = 12;
export const DEFAULT_MAX_BODY_CHARS = 600;

/**
 * Reply-quote / signature markers that begin the part of a reply we drop.
 * First match (earliest index) wins. Kept broad across locales because the
 * MLOps list is international (French / Spanish / German / Greek seen in the
 * real replies).
 */
const QUOTE_MARKERS: RegExp[] = [
  /\n\s*On .+?wrote:/is,                 // Gmail / Apple English
  /\n\s*Le .+?a écrit\s*:/is,            // French
  /\n\s*El .+?escribió\s*:/is,           // Spanish
  /\n\s*Am .+?schrieb\s+/is,             // German
  /\n\s*Στις .+?έγραψε/is,               // Greek
  /\n-----\s*Original Message\s*-----/i, // Outlook
  /\n_{5,}/,                             // Outlook divider line
  /\n\s*From:\s.+/i,                     // Outlook header block
  /\n\s*Sent from /i,                    // mobile signatures
  /\n>+ /,                               // quoted-line prefix
];

/**
 * Strip the quoted newsletter thread and cap length. Returns the
 * meaningful part of the reply — the replier's own words.
 */
export function trimReplyBody(
  raw: string | null | undefined,
  maxChars: number = DEFAULT_MAX_BODY_CHARS,
): string {
  if (!raw) return '';
  // Normalise CRLF so marker regexes and length are consistent.
  let text = raw.replace(/\r\n/g, '\n');

  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  text = text.slice(0, cut);

  return text.trim().slice(0, maxChars);
}

/** Prepare one reply row for the recipe (trim body, coerce nulls). */
export function prepareReply(row: ReplyRow, maxChars?: number): PreparedReply {
  return {
    id: row.id,
    from_name: row.from_name ?? '',
    subject: row.subject ?? '',
    body_text: trimReplyBody(row.body_text, maxChars),
  };
}

/** Split prepared replies into fixed-size batches (order preserved). */
export function toBatches<T>(items: T[], size: number = DEFAULT_BATCH_SIZE): T[][] {
  const n = Math.max(1, Math.floor(size));
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += n) {
    batches.push(items.slice(i, i + n));
  }
  return batches;
}
