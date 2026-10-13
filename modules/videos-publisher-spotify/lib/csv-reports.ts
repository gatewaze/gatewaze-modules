/**
 * Spotify for Creators CSV exports.
 *
 * The dashboard exports "any chart in the Analytics section", which in
 * practice means seven distinct file shapes across two scopes. They were
 * measured against real exports from the Agentic Conversations account on
 * 2026-10-12, because the column schema is documented nowhere and the first
 * version of this importer guessed it wrong and accepted none of them.
 *
 * Show level, all daily series:
 *   Performance        Date, Plays & downloads, Plays (on Spotify),
 *                      Downloads (everywhere else), Audience,
 *                      Audience (on Spotify), Audience (everywhere else)
 *   Engagement         Date, Consumption time (hours),
 *                      Average consumption time (hours), Comments, Followers
 *   AudienceSegments   Date, Total, Returning, New
 *   DailyImpressions   Date, Impressions
 *
 * Episode level:
 *   PerformanceCombined  Date, Plays & downloads, Audience   (CUMULATIVE)
 *   DailyImpressions     Date, Impressions                   (daily)
 *   Gender               Gender, Percentage                   (distribution)
 *   AgeByGender          Age, Total percentage, + one column per gender
 *
 * Three things about this set are load-bearing, and each one is a way to be
 * confidently wrong:
 *
 *   1. The per-episode performance export is CUMULATIVE while the show-level
 *      one is DAILY, and both call the column "Plays & downloads". Summing
 *      the cumulative one reports 951,340 plays for an episode that had
 *      2,634. Semantics are therefore read from the data (a series that only
 *      ever rises is cumulative) rather than from the column name.
 *
 *   2. Scope cannot be read from the data at all. The show-level and
 *      per-episode impressions exports have byte-identical headers. Only the
 *      filename distinguishes them, by carrying an episode slug between the
 *      show name and the report name. So the filename is required, and a
 *      slug matching no known episode is refused rather than guessed.
 *
 *   3. Followers is a LEVEL, not a flow. It runs 2 to 8,957 over the show's
 *      life and dips when people unfollow. An earlier note in this module
 *      claimed it was "new followers in the period"; that was wrong, and
 *      storing it as a flow would have made the follower count meaningless.
 */

/** The day Spotify redefined a "play" as thirty seconds or more. */
export const PLAY_DEFINITION_CHANGED_ON = '2026-06-11';

export type PlayDefinition = 'pre_2026_06_11' | 'thirty_second';

export function playDefinitionFor(day: string): PlayDefinition {
  return day < PLAY_DEFINITION_CHANGED_ON ? 'pre_2026_06_11' : 'thirty_second';
}

export type ReportKind =
  | 'performance'
  | 'engagement'
  | 'audience_segments'
  | 'impressions'
  | 'performance_combined'
  | 'gender'
  | 'age_by_gender';

export type ReportScope = 'show' | 'episode';
export type SeriesKind = 'daily' | 'cumulative' | 'distribution';

export interface ReportIdentity {
  kind: ReportKind;
  scope: ReportScope;
  series: SeriesKind;
  /** The slug Spotify puts in the filename, for an episode-scoped export. */
  episodeSlug: string | null;
  /** Why the identification failed, when it did. */
  problem?: string;
}

/** A day of numbers for one subject. All fields optional; absent is not zero. */
export interface DailyRow {
  day: string;
  plays?: number;
  playsSpotify?: number;
  downloadsElsewhere?: number;
  audience?: number;
  audienceSpotify?: number;
  audienceElsewhere?: number;
  audienceReturning?: number;
  audienceNew?: number;
  consumptionSeconds?: number;
  comments?: number;
  /** A level, not a flow. */
  followers?: number;
  impressions?: number;
}

/**
 * Whether a field may be added up.
 *
 * A flow is a count of things that happened on a day, so a range of days
 * sums. A level is the state on that day, so a range takes the last value
 * and summing it is nonsense: adding `followers` across 2,391 days gives
 * 9,804,406 for a show with 8,957 followers. A unique count is a level for
 * the day it describes and cannot be combined at all, because the same
 * listener on two days is one person, and Spotify does not tell us which.
 *
 * Declared here so that aggregation does not depend on anyone remembering
 * which is which. `totalFor` refuses rather than guessing.
 */
export type FieldKind = 'flow' | 'level' | 'unique';

/** Every field of DailyRow except the day itself. */
export type MetricField = Exclude<keyof DailyRow, 'day'>;

export const FIELD_KINDS: Record<MetricField, FieldKind> = {
  plays: 'flow',
  playsSpotify: 'flow',
  downloadsElsewhere: 'flow',
  consumptionSeconds: 'flow',
  comments: 'flow',
  impressions: 'flow',
  audienceNew: 'flow',
  followers: 'level',
  audience: 'unique',
  audienceSpotify: 'unique',
  audienceElsewhere: 'unique',
  audienceReturning: 'unique',
};

/**
 * The right single figure for a field over a range of days, or null when
 * there is no honest one.
 *
 * Returning null for a unique count is the point. "487,185 listeners" was
 * the number my own first pass produced by summing daily uniques, and it is
 * wrong by however many people listened on more than one day.
 */
export function totalFor(
  field: MetricField,
  rows: DailyRow[],
): { value: number | null; basis: 'sum' | 'latest' | 'peak'; note?: string } {
  const present = rows
    .filter((r) => typeof r[field] === 'number')
    .sort((a, b) => a.day.localeCompare(b.day));
  if (present.length === 0) return { value: null, basis: 'sum', note: 'no data' };
  const vals = present.map((r) => r[field] as number);

  switch (FIELD_KINDS[field] ?? 'flow') {
    case 'flow':
      return { value: vals.reduce((a, b) => a + b, 0), basis: 'sum' };
    case 'level':
      return { value: vals[vals.length - 1], basis: 'latest' };
    case 'unique':
      return {
        value: null,
        basis: 'peak',
        note:
          'a daily unique count cannot be summed over a range, because the same '
          + `listener on two days is one person. Peak day was ${Math.max(...vals)}.`,
      };
  }
}

/** One cell of a demographic breakdown, as a percentage of the audience. */
export interface DemographicCell {
  dimension: 'gender' | 'age' | 'age_by_gender';
  /** e.g. '35-44' for age, or null on a gender-only row. */
  ageBucket: string | null;
  /** e.g. 'male', or null on an age-only row. */
  genderBucket: string | null;
  percentage: number;
}

export interface ParsedReport {
  identity: ReportIdentity;
  rows: DailyRow[];
  demographics: DemographicCell[];
  /** Headings we did not recognise, so an operator can tell us to add them. */
  unknownHeadings: string[];
  /** Lines we could not read, counted rather than dropped in silence. */
  skipped: number;
  /** True when the window spans the play-definition change. */
  straddlesDefinitionChange: boolean;
  /** Set when the file could not be used at all. */
  refused?: string;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180 enough for a real export: quotes, embedded commas, doubled
 *  quotes, CRLF. */
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

/**
 * A heading reduced to a comparison key.
 *
 * Parentheses are dropped rather than kept, so "Plays (on Spotify)" becomes
 * "plays on spotify". The BOM the Performance export carries on its first
 * header is stripped by the same character filter.
 */
const norm = (s: string) =>
  s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 &]/g, '').trim();

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
 * midnight, so `toISOString()` shifts the day backwards west of UTC and every
 * figure lands against the wrong date.
 */
export function parseDay(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  // M/D/YYYY, which is what every export measured so far uses.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

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

// ── Identification ──────────────────────────────────────────────────────────

/** Column aliases per report, by normalised heading. */
const DAILY_COLUMNS: Record<string, MetricField> = {
  'plays & downloads': 'plays',
  'plays and downloads': 'plays',
  'plays on spotify': 'playsSpotify',
  'downloads everywhere else': 'downloadsElsewhere',
  audience: 'audience',
  'audience on spotify': 'audienceSpotify',
  'audience everywhere else': 'audienceElsewhere',
  returning: 'audienceReturning',
  new: 'audienceNew',
  comments: 'comments',
  followers: 'followers',
  impressions: 'impressions',
};

/** Hours in the file, seconds in the database. A float hour count loses
 *  nothing at this precision and integers compare cleanly. */
const HOURS_COLUMNS = new Set(['consumption time hours', 'consumption time']);

/** Deliberately NOT imported. It is derivable from consumption time and
 *  audience, and Spotify's own value disagrees with that division on some
 *  days, so storing it would create two answers to one question. */
const DERIVED_COLUMNS = new Set(['average consumption time hours', 'average consumption time']);

const DATE_KEYS = new Set(['date', 'day']);

/**
 * Which report a file is, from its name and its contents.
 *
 * The filename shape is
 * `<Show>_[<EpisodeSlug>_]<ReportName>_<range>.csv`, so the segment before
 * the report name is the episode slug when there is one.
 */
export function identifyReport(
  filename: string,
  headings: string[],
  rows: string[][],
): ReportIdentity {
  const h = headings.map(norm);
  const base = filename.replace(/\.csv$/i, '');

  const reportNames: Array<[RegExp, ReportKind]> = [
    [/PerformanceCombined/i, 'performance_combined'],
    [/AgeByGender/i, 'age_by_gender'],
    [/DailyImpressions/i, 'impressions'],
    [/AudienceSegments/i, 'audience_segments'],
    [/Engagement/i, 'engagement'],
    [/Performance/i, 'performance'],
    [/Gender/i, 'gender'],
  ];

  let kind: ReportKind | null = null;
  let nameMatch = '';
  for (const [re, k] of reportNames) {
    const m = re.exec(base);
    if (m) { kind = k; nameMatch = m[0]; break; }
  }

  // Fall back to the columns when the filename has been renamed. This can
  // name the report but never its scope, which is the whole problem.
  if (!kind) {
    if (h.includes('gender') && h.includes('percentage')) kind = 'gender';
    else if (h.includes('age')) kind = 'age_by_gender';
    else if (h.includes('followers')) kind = 'engagement';
    else if (h.includes('returning') && h.includes('new')) kind = 'audience_segments';
    else if (h.includes('impressions')) kind = 'impressions';
    else if (h.includes('plays on spotify')) kind = 'performance';
    else {
      return {
        kind: 'performance', scope: 'show', series: 'daily', episodeSlug: null,
        problem: `could not tell which report this is from the name "${filename}" or its columns`,
      };
    }
  }

  // Scope. The episode slug sits between the show name and the report name.
  let episodeSlug: string | null = null;
  if (nameMatch) {
    const before = base.slice(0, base.indexOf(nameMatch)).replace(/_+$/, '');
    const parts = before.split('_').filter(Boolean);
    // parts[0] is the show; anything after it is the episode.
    if (parts.length > 1) episodeSlug = parts.slice(1).join('_');
  }
  const scope: ReportScope = episodeSlug ? 'episode' : 'show';

  if (kind === 'gender' || kind === 'age_by_gender') {
    return { kind, scope, series: 'distribution', episodeSlug };
  }

  // Daily or cumulative, read from the numbers. A real daily series for a
  // podcast dips; a cumulative one never does.
  const dateIdx = h.findIndex((x) => DATE_KEYS.has(x));
  const metricIdx = h.findIndex((x, i) => i !== dateIdx && (DAILY_COLUMNS[x] || HOURS_COLUMNS.has(x)));
  let series: SeriesKind = 'daily';
  let problem: string | undefined;

  if (dateIdx >= 0 && metricIdx >= 0) {
    const vals = rows
      .map((r) => parseNumber(r[metricIdx]))
      .filter((v): v is number => v !== undefined);
    const nonZero = vals.filter((v) => v !== 0);
    if (vals.length >= 2) {
      const rises = vals.every((v, i) => i === 0 || v >= vals[i - 1]);
      if (rises && nonZero.length >= 2) {
        series = 'cumulative';
        // A short run can rise by chance. Say so rather than deciding.
        if (vals.length < 10) {
          problem =
            `only ${vals.length} rows and every value rises, so daily and cumulative `
            + 'cannot be told apart. Export a longer range.';
        }
      }
    } else {
      problem = 'too few rows to tell a daily series from a cumulative one';
    }
  }

  return { kind, scope, series, episodeSlug, problem };
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * A cumulative series as daily values.
 *
 * Exact, because the series starts on the publish date, so the first row is
 * both the first day's total and its delta. The deltas therefore sum back to
 * the final cumulative figure.
 */
export function differenceCumulative(values: Array<number | undefined>): Array<number | undefined> {
  const out: Array<number | undefined> = [];
  let previous = 0;
  for (const v of values) {
    if (v === undefined) { out.push(undefined); continue; }
    const delta = v - previous;
    previous = v;
    // A cumulative series that drops means a correction upstream. Record
    // nothing for that day rather than a negative count.
    out.push(delta >= 0 ? delta : undefined);
  }
  return out;
}

const GENDER_BUCKETS: Record<string, string> = {
  male: 'male',
  female: 'female',
  'non binary': 'non_binary',
  nonbinary: 'non_binary',
  'not specified': 'not_specified',
  unknown: 'not_specified',
};

export function parseSpotifyReport(filename: string, text: string): ParsedReport {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const empty: ParsedReport = {
    identity: { kind: 'performance', scope: 'show', series: 'daily', episodeSlug: null },
    rows: [], demographics: [], unknownHeadings: [], skipped: 0,
    straddlesDefinitionChange: false,
  };
  if (lines.length < 2) return { ...empty, refused: 'the file has no data rows' };

  const headings = parseCsvLine(lines[0]);
  const cells = lines.slice(1).map(parseCsvLine);
  const identity = identifyReport(filename, headings, cells);
  if (identity.problem && identity.series !== 'distribution' && /could not tell/.test(identity.problem)) {
    return { ...empty, identity, refused: identity.problem };
  }

  const h = headings.map(norm);

  // ── Distributions ────────────────────────────────────────────────────────
  if (identity.series === 'distribution') {
    const demographics: DemographicCell[] = [];
    let skipped = 0;

    if (identity.kind === 'gender') {
      const gi = h.indexOf('gender');
      const pi = h.indexOf('percentage');
      if (gi < 0 || pi < 0) return { ...empty, identity, refused: 'no Gender/Percentage columns' };
      for (const r of cells) {
        const bucket = GENDER_BUCKETS[norm(r[gi] ?? '')];
        const pct = parseNumber(r[pi]);
        if (!bucket || pct === undefined) { skipped += 1; continue; }
        demographics.push({ dimension: 'gender', ageBucket: null, genderBucket: bucket, percentage: pct });
      }
    } else {
      const ai = h.indexOf('age');
      if (ai < 0) return { ...empty, identity, refused: 'no Age column' };
      // Every "<gender> percentage" column becomes a cell; "total percentage"
      // is the row marginal and is kept as an age-only cell.
      const cols: Array<{ i: number; gender: string | null }> = [];
      h.forEach((name, i) => {
        if (i === ai) return;
        const m = /^(.*) percentage$/.exec(name);
        if (!m) return;
        const who = m[1].trim();
        cols.push({ i, gender: who === 'total' ? null : (GENDER_BUCKETS[who] ?? who.replace(/ /g, '_')) });
      });
      for (const r of cells) {
        const age = (r[ai] ?? '').trim();
        if (!age) { skipped += 1; continue; }
        for (const c of cols) {
          const pct = parseNumber(r[c.i]);
          if (pct === undefined) continue;
          demographics.push({
            dimension: c.gender === null ? 'age' : 'age_by_gender',
            ageBucket: age,
            genderBucket: c.gender,
            percentage: pct,
          });
        }
      }
    }

    const claimed = new Set<number>();
    h.forEach((name, i) => {
      if (DATE_KEYS.has(name) || name === 'gender' || name === 'age' || name === 'percentage'
        || /percentage$/.test(name)) claimed.add(i);
    });
    return {
      identity, rows: [], demographics,
      unknownHeadings: h.filter((_, i) => !claimed.has(i)).filter(Boolean),
      skipped, straddlesDefinitionChange: false,
    };
  }

  // ── Time series ──────────────────────────────────────────────────────────
  const dateIdx = h.findIndex((x) => DATE_KEYS.has(x));
  if (dateIdx < 0) {
    return { ...empty, identity, refused: 'no Date column, so the numbers cannot be placed in time' };
  }

  const metricCols: Array<{ i: number; field: MetricField; hours?: boolean }> = [];
  const claimed = new Set<number>([dateIdx]);
  h.forEach((name, i) => {
    if (i === dateIdx) return;
    if (DERIVED_COLUMNS.has(name)) { claimed.add(i); return; }
    const field = DAILY_COLUMNS[name];
    if (field) { metricCols.push({ i, field }); claimed.add(i); return; }
    if (HOURS_COLUMNS.has(name)) {
      metricCols.push({ i, field: 'consumptionSeconds', hours: true });
      claimed.add(i);
    }
  });

  // The Audience Segments export names its own total column "Total".
  if (identity.kind === 'audience_segments') {
    const ti = h.indexOf('total');
    if (ti >= 0 && !claimed.has(ti)) { metricCols.push({ i: ti, field: 'audience' }); claimed.add(ti); }
  }

  const unknownHeadings = h.filter((_, i) => !claimed.has(i)).filter(Boolean);
  if (metricCols.length === 0) {
    return { ...empty, identity, unknownHeadings, refused: 'no recognised metric columns' };
  }

  // Collect per column so a cumulative file can be differenced.
  const days: Array<string | null> = cells.map((r) => parseDay(r[dateIdx]));
  const byField = new Map<MetricField, Array<number | undefined>>();
  for (const c of metricCols) {
    let vals = cells.map((r) => {
      const n = parseNumber(r[c.i]);
      if (n === undefined) return undefined;
      return c.hours ? Math.round(n * 3600) : n;
    });
    // Followers is a level even in a cumulative-looking file, so it is never
    // differenced. Everything else in a cumulative export is a running total.
    if (identity.series === 'cumulative' && c.field !== 'followers') {
      vals = differenceCumulative(vals);
    }
    byField.set(c.field, vals);
  }

  const rows: DailyRow[] = [];
  const seen = new Map<string, DailyRow>();
  let skipped = 0;
  for (let r = 0; r < cells.length; r += 1) {
    const day = days[r];
    if (!day) { skipped += 1; continue; }
    // The Audience Segments export carried a duplicate row for one date, so
    // later values replace earlier ones rather than appearing twice.
    const row: DailyRow = seen.get(day) ?? { day };
    let any = false;
    for (const [field, vals] of byField) {
      const v = vals[r];
      if (v !== undefined) { row[field] = v; any = true; }
    }
    if (!any && !seen.has(day)) { skipped += 1; continue; }
    if (!seen.has(day)) { seen.set(day, row); rows.push(row); }
  }

  const sorted = rows.map((r) => r.day).sort();
  const straddles = sorted.length > 0
    && playDefinitionFor(sorted[0]) !== playDefinitionFor(sorted[sorted.length - 1]);

  return { identity, rows, demographics: [], unknownHeadings, skipped, straddlesDefinitionChange: straddles };
}

/**
 * An episode slug from a filename, matched against known episode titles.
 *
 * Spotify strips everything but letters and digits, so the comparison does
 * the same. Verified against the real account: all 555 episode titles reduce
 * to distinct keys, so an exact match is unambiguous. A prefix match is
 * allowed because a long title may be truncated in the filename, but it is
 * only accepted when exactly one episode matches.
 */
export function matchEpisodeSlug<T extends { id: string; title: string | null; publish_date?: string | null }>(
  slug: string,
  episodes: T[],
  opts: { firstDay?: string | null } = {},
): { episode: T | null; reason: string } {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = key(slug);
  if (!want) return { episode: null, reason: 'the filename carries no episode name' };

  const exact = episodes.filter((e) => key(e.title ?? '') === want);
  if (exact.length === 1) return { episode: exact[0], reason: 'exact title match' };

  const prefix = episodes.filter((e) => key(e.title ?? '').startsWith(want));
  const pool = exact.length > 1 ? exact : prefix;

  // A "since-published" export starts on the publish date, which separates
  // two episodes whose titles share a prefix.
  if (pool.length > 1 && opts.firstDay) {
    const sameDay = pool.filter((e) => (e.publish_date ?? '').slice(0, 10) === opts.firstDay);
    if (sameDay.length === 1) return { episode: sameDay[0], reason: 'title and publish date match' };
  }
  if (pool.length === 1) return { episode: pool[0], reason: 'title prefix match' };
  if (pool.length === 0) return { episode: null, reason: `no episode matches "${slug}"` };
  return { episode: null, reason: `${pool.length} episodes match "${slug}"; refusing to guess` };
}
