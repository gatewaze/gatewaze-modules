/**
 * Matching a video's YouTube title to an event's agenda, with no I/O.
 *
 * Used when the conference recap has not already matched the YouTube id to a
 * talk. YouTube titles for a conference talk are usually the talk title with
 * decoration: a speaker name after a dash, a track prefix, the event name in
 * brackets. The agenda title is usually the undecorated one. So the test is
 * containment after normalisation, in either direction, and it only counts
 * when exactly one agenda entry fits. Two fits is "no match", because the
 * cost of attaching a recording to the wrong talk is higher than leaving it
 * for an operator.
 */

import { normaliseTitle } from './takeout-match.js';

export interface AgendaCandidate {
  id: string;
  title: string;
}

/** Titles shorter than this are too generic to match on ("Keynote", "Panel"). */
const MIN_TITLE_CHARS = 12;

export function matchAgendaByTitle(videoTitle: string, entries: AgendaCandidate[]): AgendaCandidate | null {
  const v = normaliseTitle(videoTitle);
  if (v.length < MIN_TITLE_CHARS) return null;
  const fits = entries.filter((e) => {
    const a = normaliseTitle(e.title);
    if (a.length < MIN_TITLE_CHARS) return false;
    return a === v || v.includes(a) || a.includes(v);
  });
  if (fits.length !== 1) return null;
  return fits[0];
}

/**
 * The fields the importer keeps from yt-dlp's info.json; everything else is
 * dropped. Chapters are parsed for the clipping pipeline, which is the
 * consumer; nothing stores them yet.
 */
export interface VideoMeta {
  title: string | null;
  description: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  chapters: Array<{ title: string; start: number; end: number }>;
}

export function metaFromInfoJson(raw: unknown): VideoMeta {
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const num = (v: unknown, max = Number.MAX_SAFE_INTEGER) =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? Math.round(v) : null);
  // upload_date is YYYYMMDD; release_timestamp / timestamp are unix seconds.
  // Either way the result has to be a date Postgres will take, so it is
  // parsed back before it is kept.
  let publishedAt: string | null = null;
  const ts = num(j.release_timestamp, 4_102_444_800) ?? num(j.timestamp, 4_102_444_800);
  if (ts) publishedAt = new Date(ts * 1000).toISOString();
  else if (typeof j.upload_date === 'string' && /^\d{8}$/.test(j.upload_date)) {
    const iso = `${j.upload_date.slice(0, 4)}-${j.upload_date.slice(4, 6)}-${j.upload_date.slice(6, 8)}T00:00:00.000Z`;
    publishedAt = Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso ? iso : null;
  }
  const chapters = Array.isArray(j.chapters)
    ? j.chapters
      .map((c) => (c && typeof c === 'object' ? c : {}) as Record<string, unknown>)
      .map((c) => ({ title: str(c.title, 200) ?? '', start: num(c.start_time) ?? 0, end: num(c.end_time) ?? 0 }))
      .filter((c) => c.title && c.end > c.start)
      .slice(0, 500)
    : [];
  return {
    title: str(j.title, 300),
    description: str(j.description, 10_000),
    // A week is longer than any livestream and well inside an integer column.
    durationSeconds: num(j.duration, 7 * 86_400),
    publishedAt,
    chapters,
  };
}
