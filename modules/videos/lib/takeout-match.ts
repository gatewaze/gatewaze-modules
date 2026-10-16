/**
 * Matching Takeout files to the videos we already know, with no I/O.
 *
 * A YouTube Takeout export is a folder of video files named after their
 * titles, plus a `videos.csv` under "video metadata" that carries the video
 * id, the title and the duration. When the CSV is there the match is exact.
 * When it is not (somebody uploaded a handful of files by hand), the match
 * falls back to the title, normalised hard enough to survive the characters
 * Takeout strips from filenames.
 *
 * Nothing here decides what to do with an unmatched file; it only says which
 * ones matched and how confidently.
 */

export interface KnownVideo {
  id: string;
  provider_video_id: string;
  title: string;
  duration_seconds?: number | null;
}

export interface TakeoutRow {
  videoId: string;
  title: string;
  durationSeconds: number | null;
}

export interface MatchResult {
  /** The videos row the file belongs to. */
  videoId: string;
  youtubeId: string;
  /**
   * 'filename' is the YouTube id in square brackets in the name (yt-dlp's
   * `[%(id)s]` template); 'csv' is Takeout's own mapping; 'title' is a
   * normalised-title match. The first two are exact.
   */
  by: 'filename' | 'csv' | 'title';
}

/** The YouTube id a filename carries in square brackets, or null. */
export function youtubeIdInFilename(filename: string): string | null {
  const m = String(filename ?? '').match(/\[([A-Za-z0-9_-]{11})\](?:\.[a-z0-9]+)?$/i);
  return m ? m[1] : null;
}

/**
 * The YouTube id for an object key: the folder it sits in when that folder
 * is an id (`local-import/<id>/<file>`), else the brackets in the filename.
 * The folder wins because a shipper that sanitises names for S3 may have
 * turned the brackets into dashes, while the folder it chose is exact.
 */
export function youtubeIdFromKey(key: string): string | null {
  const parts = String(key ?? '').split('/');
  const name = parts.pop() ?? '';
  const folder = parts.pop() ?? '';
  if (/^[A-Za-z0-9_-]{11}$/.test(folder)) return folder;
  return youtubeIdInFilename(name);
}

/** Video containers Takeout hands out. Anything else in the folder is metadata. */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'] as const;

export function isVideoFile(name: string): boolean {
  const lower = String(name ?? '').toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * A title reduced to letters, digits and single spaces, lower-cased.
 *
 * Takeout replaces `: / ? " * < > |` and friends in filenames, trims the
 * title to fit, and sometimes appends a numeric suffix for duplicates. So the
 * comparison drops everything that is not a letter or digit on both sides.
 */
export function normaliseTitle(title: string): string {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.(mp4|mov|webm|mkv|m4v)$/i, '')
    .replace(/\s*\[[A-Za-z0-9_-]{11}\]$/, '')
    .replace(/\(\d+\)$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Minimal CSV parsing: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.length > 0)) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.length > 0)) rows.push(row);
  return rows;
}

/**
 * The rows of a Takeout `videos.csv`, or an empty list when the CSV is not
 * one (no "Video ID" column).
 *
 * Column names have changed across Takeout versions, so each one is found by
 * a loose match on the header rather than a fixed index.
 */
export function parseTakeoutCsv(text: string): TakeoutRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...needles: string[]) => header.findIndex((h) => needles.every((n) => h.includes(n)));
  const idCol = col('video id');
  if (idCol < 0) return [];
  const titleCol = (() => {
    const original = col('title', 'original');
    return original >= 0 ? original : col('title');
  })();
  const durationCol = col('duration');
  const out: TakeoutRow[] = [];
  for (const r of rows.slice(1)) {
    const videoId = String(r[idCol] ?? '').trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    const rawDuration = durationCol >= 0 ? Number(String(r[durationCol] ?? '').trim()) : NaN;
    out.push({
      videoId,
      title: titleCol >= 0 ? String(r[titleCol] ?? '').trim() : '',
      // Takeout gives milliseconds ("Approx Duration (ms)"); an older export
      // gave seconds. Anything over a day in seconds must be milliseconds.
      durationSeconds: Number.isFinite(rawDuration) && rawDuration > 0
        ? Math.round(rawDuration > 86_400 ? rawDuration / 1000 : rawDuration)
        : null,
    });
  }
  return out;
}

/**
 * Match one file to a known video.
 *
 * The CSV wins when it names the file's title exactly (after normalisation)
 * and that id is known. Otherwise the title alone, and only when exactly one
 * known video has that normalised title; two candidates is "unmatched", not
 * a coin toss.
 */
export function matchFile(
  filename: string,
  known: KnownVideo[],
  csv: TakeoutRow[],
): MatchResult | null {
  const byYoutubeId = new Map(known.map((k) => [k.provider_video_id, k]));

  // An id in the name is the strongest signal there is, and the one a
  // yt-dlp download carries. Unknown id means unmatched, not a title guess:
  // the name said exactly which video it is, and we do not have that one.
  const inName = youtubeIdInFilename(filename);
  if (inName) {
    const k = byYoutubeId.get(inName);
    return k ? { videoId: k.id, youtubeId: k.provider_video_id, by: 'filename' } : null;
  }

  const wanted = normaliseTitle(filename);
  if (!wanted) return null;

  const csvHit = csv.find((r) => normaliseTitle(r.title) === wanted);
  if (csvHit) {
    const k = byYoutubeId.get(csvHit.videoId);
    if (k) return { videoId: k.id, youtubeId: k.provider_video_id, by: 'csv' };
  }

  const titleHits = known.filter((k) => normaliseTitle(k.title) === wanted);
  if (titleHits.length === 1) {
    return { videoId: titleHits[0].id, youtubeId: titleHits[0].provider_video_id, by: 'title' };
  }
  return null;
}
