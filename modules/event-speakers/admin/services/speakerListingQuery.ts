/**
 * Query shaping for the Speakers directory listing.
 *
 * Pure — deliberately free of any `@/lib/supabase` (or other platform-aliased)
 * import so the unit tests can load standalone. The repo's module-tests CI
 * installs each module in isolation and treats a test file that fails to
 * import as SKIPPED rather than FAILED, so anything that reaches for a
 * platform alias is silently uncovered. Validation and sanitisation therefore
 * live here, and `speakersRollupService` is the thin Supabase shim over them.
 *
 * URL param contract (borrowed verbatim from the platform listing pattern so a
 * later migration onto the listing primitive is a drop-in):
 *   q, sort, dir, page, pageSize   — plus `eventId` for this listing's filter.
 */

/** Columns the directory is allowed to sort by. Anything else falls back. */
export const SPEAKER_SORT_COLUMNS = ['name', 'company', 'email', 'event_count'] as const;
export type SpeakerSortColumn = (typeof SPEAKER_SORT_COLUMNS)[number];

export type SortDirection = 'asc' | 'desc';

export const DEFAULT_SPEAKER_SORT: SpeakerSortColumn = 'name';
export const DEFAULT_SPEAKER_PAGE_SIZE = 25;
export const MAX_SPEAKER_PAGE_SIZE = 100;

/**
 * Defence in depth on the cost of a search, matching the platform's
 * security-boundaries convention.
 */
export const MAX_SPEAKER_SEARCH_LENGTH = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListSpeakersOptions {
  search?: string | null;
  /** Restrict to speakers who appear on this event (uuid). */
  eventId?: string | null;
  sort?: string | null;
  dir?: string | null;
  page?: number | string | null;
  pageSize?: number | string | null;
}

export interface SpeakerListingQuery {
  sort: SpeakerSortColumn;
  direction: SortDirection;
  ascending: boolean;
  page: number;
  pageSize: number;
  /** Inclusive PostgREST range bounds. */
  from: number;
  to: number;
  /** Sanitised search term; '' when nothing usable survived. */
  search: string;
  /** Ready-to-use PostgREST `.or()` argument, or null when there's no search. */
  orFilter: string | null;
  /** Validated event uuid, or null when absent/malformed. */
  eventId: string | null;
}

/**
 * Strip PostgREST filter-grammar metacharacters before the term is
 * interpolated into an `.or()` string.
 *
 * Without this a search of `jane,id.gt.0` closes the first ilike clause and
 * adds `id.gt.0` as a second top-level disjunct — which matches every row in
 * the table. `(` and `)` group filters, `*` is the wildcard, `\` escapes.
 */
export function sanitizeSpeakerSearch(input: unknown): string {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/[,()*\\]/g, '')
    .trim()
    .slice(0, MAX_SPEAKER_SEARCH_LENGTH);
}

export function isEventUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function normalizeSpeakerSort(value: unknown): SpeakerSortColumn {
  const candidate = String(value ?? '');
  return (SPEAKER_SORT_COLUMNS as readonly string[]).includes(candidate)
    ? (candidate as SpeakerSortColumn)
    : DEFAULT_SPEAKER_SORT;
}

/**
 * "Most events first" is the useful default for a count column; alphabetical
 * columns read better ascending. Only applies when no explicit dir is given.
 */
export function defaultDirectionFor(sort: SpeakerSortColumn): SortDirection {
  return sort === 'event_count' ? 'desc' : 'asc';
}

export function normalizeSpeakerDirection(value: unknown, sort: SpeakerSortColumn): SortDirection {
  const candidate = String(value ?? '').toLowerCase();
  if (candidate === 'asc' || candidate === 'desc') return candidate;
  return defaultDirectionFor(sort);
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

/** Total page count for a result set, floored at 1 so the pager always renders. */
export function speakerPageCount(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0 || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export function buildSpeakerListingQuery(opts: ListSpeakersOptions = {}): SpeakerListingQuery {
  const sort = normalizeSpeakerSort(opts.sort);
  const direction = normalizeSpeakerDirection(opts.dir, sort);

  const pageSize = Math.min(
    toPositiveInt(opts.pageSize, DEFAULT_SPEAKER_PAGE_SIZE),
    MAX_SPEAKER_PAGE_SIZE,
  );
  const page = toPositiveInt(opts.page, 1);
  const from = (page - 1) * pageSize;

  const search = sanitizeSpeakerSearch(opts.search);

  return {
    sort,
    direction,
    ascending: direction === 'asc',
    page,
    pageSize,
    from,
    to: from + pageSize - 1,
    search,
    orFilter: search
      ? `name.ilike.%${search}%,email.ilike.%${search}%,company.ilike.%${search}%`
      : null,
    eventId: isEventUuid(opts.eventId) ? (opts.eventId as string) : null,
  };
}
