/**
 * OP3, the Open Podcast Prefix Project — the one podcast metric source with
 * a documented API and no terms-of-service question.
 *
 * Why this rather than Spotify's own numbers: Spotify has no analytics API,
 * its dashboard is `Disallow: /` in robots.txt, its User Guidelines prohibit
 * automated collection with no carve-out for your own data, and its
 * enforcement action in December 2025 was to disable the accounts involved.
 * The account in question hosts all 555 episodes, so the downside of getting
 * it wrong is the podcast going offline rather than a missing chart.
 *
 * What OP3 gives up in exchange, which the UI must be honest about:
 *
 *   - It counts DOWNLOADS, not Spotify's "plays". Since 11 June 2026 a
 *     Spotify play means thirty seconds of listening; an OP3 download is a
 *     request for the file. These will never reconcile, and labelling an OP3
 *     figure as "Spotify plays" would be worse than showing nothing.
 *   - It only counts from the day the prefix is added to the feed. There is
 *     no backfill. Every week of delay is history that cannot be recovered.
 *
 * What it gives that nothing else does: a per-app breakdown, so the Spotify
 * share can be separated from Apple and Overcast, on a documented endpoint
 * with bearer auth and no credential belonging to a person.
 *
 * https://op3.dev — source at github.com/skymethod/op3
 */

const API_BASE = 'https://op3.dev/api/1';
const TIMEOUT_MS = 30_000;

export interface Op3EpisodeCounts {
  /** The episode's audio URL as OP3 knows it, which is the join key. */
  episodeUrl: string;
  /** Downloads in the trailing window. Absent when OP3 has no data yet. */
  day1?: number;
  day3?: number;
  day7?: number;
  day30?: number;
  allTime?: number;
}

export interface Op3Result<T> {
  status: 'ok' | 'no_data' | 'auth' | 'error';
  detail?: string;
  data?: T;
}

async function get<T>(path: string, token: string): Promise<Op3Result<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { status: 'auth', detail: `OP3 returned ${res.status}` };
    }
    if (!res.ok) return { status: 'error', detail: `OP3 returned ${res.status}` };
    return { status: 'ok', data: (await res.json()) as T };
  } catch (err) {
    return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-episode download counts for a show.
 *
 * Keyed by the episode's audio URL rather than by any id, because that is
 * what OP3 observes: it sits in front of the enclosure and counts requests.
 * The feed's enclosure URL is therefore the join back to our own rows, and
 * it is why the discovery worker stores it.
 */
export async function episodeDownloadCounts(
  showUuid: string,
  token: string,
): Promise<Op3Result<Op3EpisodeCounts[]>> {
  const res = await get<{ episodeFirstHours?: Record<string, Record<string, number>> } & Record<string, unknown>>(
    `/queries/episode-download-counts?showUuid=${encodeURIComponent(showUuid)}`,
    token,
  );
  if (res.status !== 'ok') return { status: res.status, detail: res.detail };

  const rows = (res.data as { rows?: Array<Record<string, unknown>> })?.rows
    ?? (res.data as { episodes?: Array<Record<string, unknown>> })?.episodes
    ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    // OP3 answered and had nothing. That is no_data, not zero: a prefix
    // added yesterday legitimately has no counts yet, and writing 0
    // downloads for 555 episodes would look like the show had died.
    return { status: 'no_data', detail: 'OP3 returned no episode rows' };
  }

  const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
  return {
    status: 'ok',
    data: rows
      .map((r) => ({
        episodeUrl: String(r.episodeUrl ?? r.url ?? ''),
        day1: num(r.day1 ?? r.downloads1),
        day3: num(r.day3 ?? r.downloads3),
        day7: num(r.day7 ?? r.downloads7),
        day30: num(r.day30 ?? r.downloads30),
        allTime: num(r.allTime ?? r.downloadsAllTime ?? r.total),
      }))
      .filter((r) => r.episodeUrl),
  };
}

export interface Op3AppShare {
  appName: string;
  downloads: number;
}

/**
 * Downloads split by listening app, which is how the Spotify share is told
 * from Apple's.
 *
 * This is the number that can honestly be attributed to a platform. It is
 * still a download rather than a play, so it answers "how many people pulled
 * this episode through Spotify" and not "how many listened for thirty
 * seconds".
 */
export async function downloadsByApp(
  showUuid: string,
  token: string,
  opts: { start?: string; end?: string } = {},
): Promise<Op3Result<Op3AppShare[]>> {
  const params = new URLSearchParams({ showUuid });
  if (opts.start) params.set('start', opts.start);
  if (opts.end) params.set('end', opts.end);

  const res = await get<Record<string, unknown>>(`/queries/top-apps-for-show?${params}`, token);
  if (res.status !== 'ok') return { status: res.status, detail: res.detail };

  const rows = (res.data as { rows?: Array<Record<string, unknown>> })?.rows ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { status: 'no_data', detail: 'OP3 returned no app rows' };
  }
  return {
    status: 'ok',
    data: rows
      .map((r) => ({
        appName: String(r.appName ?? r.app ?? 'unknown'),
        downloads: Number(r.downloads ?? r.count ?? 0),
      }))
      .filter((r) => r.appName !== 'unknown' || r.downloads > 0),
  };
}

/**
 * Whether a feed is actually prefixed with OP3 yet.
 *
 * Worth checking before every collection and worth surfacing: OP3 counts
 * nothing until the prefix is in the enclosure URLs, and a collector that
 * silently returned no_data forever would look like a broken integration
 * rather than an un-done setup step.
 */
export function feedIsPrefixed(enclosureUrl: string | null | undefined): boolean {
  return /(^|\/\/)op3\.dev\//i.test(String(enclosureUrl ?? ''));
}

/** The prefix an operator has to put in front of their enclosure URLs. */
export function prefixFor(enclosureUrl: string): string {
  return `https://op3.dev/e/${String(enclosureUrl).replace(/^https?:\/\//, '')}`;
}
