/**
 * Query-parameter parsing + summary aggregation for GET /test-env/env-events
 * (the Environments log explorer).
 *
 * Split out of api/admin-routes.ts because ALL the trust-boundary work lives
 * here: every value that reaches a PostgREST filter is re-derived from a
 * validated shape rather than passed through. Nothing in this file touches the
 * network or the filesystem, so the whole contract is unit-testable
 * (lib/__tests__/env-events-query.test.ts).
 *
 * Injection posture, filter by filter:
 *   env       — each label must match ENV_LABEL_SHAPE (lowercase alnum + '-',
 *               leading "lfx--") before it can appear in an `.in.()` list; the
 *               grammar has no comma, paren, quote or dot, so it cannot break
 *               out of a PostgREST filter list, including inside `.or()`.
 *   kind      — must match KIND_RE (^[a-z][a-z0-9_]{0,31}$), same argument.
 *   since /
 *   until /
 *   before_ts — parsed with Date.parse and RE-SERIALISED by us to a strict
 *               ISO-8601 instant; the string that reaches PostgREST is our
 *               output, never the caller's input, and is re-asserted against
 *               ISO_INSTANT_RE before use.
 *   before_id — Number.parseInt to a positive safe integer, re-serialised.
 *   q         — free-text; reduced to a conservative allowlist (see
 *               sanitizeSearch) that strips every LIKE/PostgREST metacharacter
 *               (% * \ , ( ) " ' .) before it becomes an ilike pattern.
 */
import { KIND_RE, isErrorKind, kindCategory } from './env-event-kinds.js';

/** Shape of an env label as stored by the ingester (migration 025 / LABEL_RE). */
export const ENV_LABEL_SHAPE = /^lfx--[a-z0-9]([a-z0-9-]{0,50}[a-z0-9])?$/;
/** What our own re-serialised timestamps look like — asserted before use. */
export const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;
/** Hard ceiling on rows the summary aggregation will scan in one request. */
export const SUMMARY_SCAN_CAP = 5000;
export const MAX_SEARCH = 80;
export const MAX_KINDS = 40;
export const MAX_ENVS = 25;
/** Sentinel selecting the events with no env attribution (shared-Authelia logins). */
export const NO_ENV = 'none';

export interface EventQuery {
  /** Validated env labels; empty = no env constraint. */
  envs: string[];
  /** True when the caller also/only wants env_label IS NULL rows. */
  includeUnattributed: boolean;
  /** True when `env` was supplied at all (envs may still be empty if only `none`). */
  envFilterPresent: boolean;
  kinds: string[];
  since: string | null;
  until: string | null;
  search: string | null;
  limit: number;
  beforeTs: string | null;
  beforeId: number | null;
  summary: boolean;
  buckets: number;
}

export type ParseResult =
  | { ok: true; query: EventQuery }
  | { ok: false; message: string };

const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(Array.isArray(v) ? v[0] : v);

/** Date.parse → our own strict ISO instant, or null when unparseable. */
export function normalizeInstant(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const iso = new Date(t).toISOString();
  return ISO_INSTANT_RE.test(iso) ? iso : null;
}

/**
 * Reduce a free-text search term to something that is safe as a PostgREST
 * ilike pattern AND still useful on this data (hostnames, env labels, service
 * names, Authelia prose).
 *
 * Dropped outright: the LIKE wildcards `%` and `_`-adjacent metacharacters, the
 * PostgREST `*` wildcard, the escape `\`, and the filter-grammar characters
 * `,()"'`. `_` is KEPT because it is load-bearing in this data (service_error,
 * login_failure) and, as a single-character LIKE wildcard, it still matches the
 * literal underscore the user typed — an over-match in a search box, never a
 * filter break.
 */
export function sanitizeSearch(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[%*\\,()"'`.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH);
  return cleaned.length > 0 ? cleaned : null;
}

/** Parse + validate the whole query string. Never throws. */
export function parseEventQuery(raw: Record<string, unknown>): ParseResult {
  const envRaw = str(raw.env);
  const envs: string[] = [];
  let includeUnattributed = false;
  const envFilterPresent = envRaw !== undefined && envRaw !== '';
  if (envFilterPresent) {
    const parts = (envRaw as string).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0 || parts.length > MAX_ENVS) return { ok: false, message: 'Bad env filter' };
    for (const p of parts) {
      if (p === NO_ENV) { includeUnattributed = true; continue; }
      if (!ENV_LABEL_SHAPE.test(p)) return { ok: false, message: 'Not a valid environment label' };
      if (!envs.includes(p)) envs.push(p);
    }
  }

  const kindRaw = str(raw.kind);
  const kinds: string[] = [];
  if (kindRaw !== undefined && kindRaw !== '') {
    for (const k of kindRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!KIND_RE.test(k)) return { ok: false, message: 'Bad kind filter' };
      if (!kinds.includes(k)) kinds.push(k);
    }
    if (kinds.length === 0 || kinds.length > MAX_KINDS) return { ok: false, message: 'Bad kind filter' };
  }

  const sinceRaw = str(raw.since);
  const since = normalizeInstant(sinceRaw);
  if (sinceRaw !== undefined && sinceRaw !== '' && since === null) return { ok: false, message: 'Bad since' };
  const untilRaw = str(raw.until);
  const until = normalizeInstant(untilRaw);
  if (untilRaw !== undefined && untilRaw !== '' && until === null) return { ok: false, message: 'Bad until' };
  if (since && until && since > until) return { ok: false, message: 'since is after until' };

  const limitRaw = str(raw.limit);
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined && limitRaw !== '') {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { ok: false, message: 'Bad limit' };
    limit = n;
  }

  // Keyset cursor: both halves or neither. (ts, id) descending — id breaks the
  // very common same-second ties the 60s tailer buckets produce.
  const beforeTsRaw = str(raw.before_ts);
  const beforeIdRaw = str(raw.before_id);
  let beforeTs: string | null = null;
  let beforeId: number | null = null;
  if ((beforeTsRaw !== undefined && beforeTsRaw !== '') || (beforeIdRaw !== undefined && beforeIdRaw !== '')) {
    beforeTs = normalizeInstant(beforeTsRaw);
    // Digits ONLY — parseInt would happily read "1,ts.gt.2000-01-01" as 1 and
    // swallow the tail. The tail could not survive re-serialisation, but a
    // parser that quietly accepts an injection attempt is one refactor away
    // from a parser that forwards it.
    const idStr = String(beforeIdRaw ?? '');
    if (beforeTs === null || !/^\d{1,15}$/.test(idStr)) return { ok: false, message: 'Bad cursor' };
    const n = Number.parseInt(idStr, 10);
    if (!Number.isSafeInteger(n) || n < 1) return { ok: false, message: 'Bad cursor' };
    beforeId = n;
  }

  const bucketsRaw = str(raw.buckets);
  let buckets = 48;
  if (bucketsRaw !== undefined && bucketsRaw !== '') {
    const n = Number(bucketsRaw);
    if (!Number.isInteger(n) || n < 2 || n > 240) return { ok: false, message: 'Bad buckets' };
    buckets = n;
  }

  const summaryRaw = str(raw.summary);
  const summary = summaryRaw === '1' || summaryRaw === 'true';

  return {
    ok: true,
    query: {
      envs, includeUnattributed, envFilterPresent, kinds,
      since, until, search: sanitizeSearch(str(raw.q)),
      limit, beforeTs, beforeId, summary, buckets,
    },
  };
}

// ── summary aggregation ──────────────────────────────────────────────────────

export interface SummaryRow { ts: string; kind: string; env_label: string | null }

export interface EnvSummary {
  env: string | null;
  visits: number;
  logins: number;
  login_failures: number;
  errors: number;
  lifecycle: number;
  total: number;
}

export interface EventSummary {
  total: number;
  truncated: boolean;
  window: { from: string; to: string };
  totals: Omit<EnvSummary, 'env'>;
  per_env: EnvSummary[];
  /** Total events per equal-width time bucket across the window. */
  sparkline: number[];
  /** Errors only, same buckets — the line that should shout. */
  error_sparkline: number[];
}

const emptyCounts = (): Omit<EnvSummary, 'env'> => ({
  visits: 0, logins: 0, login_failures: 0, errors: 0, lifecycle: 0, total: 0,
});

/**
 * Fold a window of rows into the at-a-glance strip: per-env counts plus two
 * equal-width-bucket sparklines. Pure and order-independent — the caller hands
 * it whatever the (capped) scan returned.
 *
 * `from`/`to` bound the buckets. Rows outside the window are still counted in
 * the per-env totals (the caller only ever passes rows it already filtered)
 * but are clamped into the first/last bucket rather than dropped, so a
 * one-second clock skew on the box cannot make an error vanish from the graph.
 */
export function summarizeEvents(
  rows: SummaryRow[],
  opts: { from: string; to: string; buckets?: number; truncated?: boolean },
): EventSummary {
  const buckets = Math.max(2, Math.min(240, opts.buckets ?? 48));
  const fromMs = Date.parse(opts.from);
  const toMs = Date.parse(opts.to);
  const span = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs ? toMs - fromMs : 1;
  const sparkline = new Array(buckets).fill(0);
  const error_sparkline = new Array(buckets).fill(0);
  const totals = emptyCounts();
  const byEnv = new Map<string, EnvSummary>();

  for (const row of rows) {
    const key = row.env_label ?? '';
    let e = byEnv.get(key);
    if (!e) { e = { env: row.env_label ?? null, ...emptyCounts() }; byEnv.set(key, e); }
    const isError = isErrorKind(row.kind);
    const bump = (c: Omit<EnvSummary, 'env'>) => {
      c.total += 1;
      if (row.kind === 'visit') c.visits += 1;
      else if (row.kind === 'login_success') c.logins += 1;
      else if (row.kind === 'login_failure') { c.login_failures += 1; c.logins += 1; }
      else if (kindCategory(row.kind) === 'lifecycle') c.lifecycle += 1;
      if (isError) c.errors += 1;
    };
    bump(e); bump(totals);

    const t = Date.parse(row.ts);
    const idx = Number.isFinite(t)
      ? Math.min(buckets - 1, Math.max(0, Math.floor(((t - fromMs) / span) * buckets)))
      : buckets - 1;
    sparkline[idx] += 1;
    if (isError) error_sparkline[idx] += 1;
  }

  const per_env = [...byEnv.values()].sort((a, b) =>
    b.errors - a.errors || b.total - a.total || String(a.env).localeCompare(String(b.env)));

  return {
    total: rows.length,
    truncated: !!opts.truncated,
    window: { from: opts.from, to: opts.to },
    totals, per_env, sparkline, error_sparkline,
  };
}
