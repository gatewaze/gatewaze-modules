/**
 * Spotify analytics CSV import.
 *
 * The officially sanctioned route: an operator opens the Creators dashboard,
 * picks a date range, clicks Export, and uploads the file here. No credential
 * is held, nothing is automated against Spotify, and there is no
 * terms-of-service question — the export button exists for exactly this.
 *
 * It is the first thing to build for that reason, and because the CSV column
 * schema is documented nowhere. This parser is therefore written to be
 * TOLERANT of the exact headings and strict about what it will write: it
 * matches columns by a set of known aliases, reports the headings it did not
 * recognise, and refuses to guess which column is the play count.
 *
 * Two facts from the research that shape the output:
 *
 *   - On 11 June 2026 Spotify redefined a "play" as thirty seconds or more
 *     of listening. An import spanning that date straddles a definition
 *     change, so every row records which side it falls on. Without that the
 *     chart shows a step nobody can explain six months later.
 *   - Followers is reported as NEW followers in the period — a flow, not a
 *     level. Storing it as a follower count would be wrong, so it is kept
 *     under its own name.
 */

/** The day Spotify's "play" became "thirty seconds or more". */
export const PLAY_DEFINITION_CHANGED_ON = '2026-06-11';

export type PlayDefinition = 'pre_2026_06_11' | 'thirty_second';

export function playDefinitionFor(day: string): PlayDefinition {
  return day < PLAY_DEFINITION_CHANGED_ON ? 'pre_2026_06_11' : 'thirty_second';
}

export interface CsvRow {
  /** Whatever identified the episode: a title, a URL, or an id. */
  episodeKey: string;
  day: string | null;
  plays?: number;
  downloads?: number;
  listeners?: number;
  followersGained?: number;
  /** Seconds. */
  consumptionTime?: number;
  completionRate?: number;
}

export interface CsvParseResult {
  rows: CsvRow[];
  /** Headings we did not recognise, so an operator can tell us what to add. */
  unknownHeadings: string[];
  /** Lines that could not be read, counted rather than silently dropped. */
  skipped: number;
  /** Null when the file carried no per-row date. */
  definition: PlayDefinition | null;
}

/**
 * RFC 4180 enough for a real export: quoted fields, embedded commas,
 * doubled quotes, and CRLF.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuotes = false; }
      } else { cur += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else { cur += c; }
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

/** Heading aliases. Spotify has renamed these before and will again. */
const COLUMNS: Record<keyof Omit<CsvRow, 'episodeKey' | 'day'>, string[]> = {
  plays: ['plays', 'starts', 'streams'],
  downloads: ['downloads', 'plays and downloads', 'plays & downloads'],
  listeners: ['listeners', 'spotify audience', 'audience', 'unique listeners'],
  followersGained: ['followers', 'new followers', 'followers gained'],
  consumptionTime: ['average consumption time', 'consumption time', 'time listened'],
  completionRate: ['completion rate', 'completion'],
};

const EPISODE_KEYS = ['episode', 'episode name', 'episode title', 'title', 'name', 'episode url', 'url'];
const DAY_KEYS = ['date', 'day'];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 &]/g, '').trim();

/** A number that may carry thousands separators, a percent sign, or be blank. */
export function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = value.replace(/[,%\s]/g, '');
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A date cell to YYYY-MM-DD, or null rather than an invented day.
 *
 * Parsed in UTC deliberately. `Date.parse('12 June 2026')` yields LOCAL
 * midnight, and `toISOString()` then converts it — so on a machine behind
 * UTC the day shifts backwards and every figure in the file is filed against
 * the wrong date. A worker running in one region and an operator exporting
 * in another would disagree by a day, silently.
 */
export function parseDay(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  // US-style, which a Spotify export may well use.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Anything else: parse, then read back the UTC parts rather than
  // round-tripping through an ISO string in local time.
  const t = Date.parse(`${v} UTC`);
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  const t2 = Date.parse(v);
  if (!Number.isFinite(t2)) return null;
  const dt = new Date(t2);
  return [
    dt.getFullYear(),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getDate()).padStart(2, '0'),
  ].join('-');
}

export function parseSpotifyCsv(text: string): CsvParseResult {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { rows: [], unknownHeadings: [], skipped: 0, definition: null };
  }

  const headings = parseCsvLine(lines[0]).map(norm);
  const indexOfAny = (aliases: string[]) => headings.findIndex((h) => aliases.includes(h));

  const epIdx = indexOfAny(EPISODE_KEYS);
  const dayIdx = indexOfAny(DAY_KEYS);
  const metricIdx: Partial<Record<keyof typeof COLUMNS, number>> = {};
  for (const [key, aliases] of Object.entries(COLUMNS) as Array<[keyof typeof COLUMNS, string[]]>) {
    const i = indexOfAny(aliases);
    if (i >= 0) metricIdx[key] = i;
  }

  const claimed = new Set<number>([epIdx, dayIdx, ...Object.values(metricIdx)].filter((i) => i >= 0));
  const unknownHeadings = headings.filter((_, i) => !claimed.has(i)).filter(Boolean);

  // Without an episode column there is nothing to attach a number to. Refuse
  // rather than attribute the whole file to one arbitrary episode.
  if (epIdx < 0) {
    return { rows: [], unknownHeadings, skipped: lines.length - 1, definition: null };
  }

  const rows: CsvRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const episodeKey = cells[epIdx];
    if (!episodeKey) { skipped += 1; continue; }
    const day = dayIdx >= 0 ? parseDay(cells[dayIdx]) : null;

    const row: CsvRow = { episodeKey, day };
    let any = false;
    for (const [key, i] of Object.entries(metricIdx) as Array<[keyof typeof COLUMNS, number]>) {
      const n = parseNumber(cells[i]);
      if (n !== undefined) { (row as Record<string, unknown>)[key] = n; any = true; }
    }
    // A row with an episode and no readable figures tells us nothing.
    if (!any) { skipped += 1; continue; }
    rows.push(row);
  }

  const days = rows.map((r) => r.day).filter(Boolean) as string[];
  const definition = days.length > 0 ? playDefinitionFor(days.sort()[0]) : null;

  return { rows, unknownHeadings, skipped, definition };
}

/**
 * Whether an import spans the play-definition change, which the caller must
 * surface rather than quietly average across.
 */
export function straddlesDefinitionChange(rows: CsvRow[]): boolean {
  const days = rows.map((r) => r.day).filter(Boolean) as string[];
  if (days.length === 0) return false;
  const sorted = [...days].sort();
  return playDefinitionFor(sorted[0]) !== playDefinitionFor(sorted[sorted.length - 1]);
}
