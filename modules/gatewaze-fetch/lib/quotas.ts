/**
 * Quota engine — two-phase accounting (spec §9.2, §9.3 step 5).
 *
 * Phase 1 (pre-debit): atomic UPDATE … RETURNING with bounded estimates
 *   for `requests` (always +1) and `browser_seconds_estimate` (60s for
 *   browser mode, 0 otherwise). Proxy bytes are NOT bounded pre-fetch.
 *
 * Phase 2 (post-reconcile): apply actual values; if exceeds limit, the
 *   request still completes (work was done) but the key is marked
 *   exhausted for future requests.
 *
 * Pre-debit + ledger insert + audit-start row all run in ONE DB
 * transaction (spec §9.3 step 5) — the caller wraps these in
 * supabase.rpc / a Postgres function or a single transaction client;
 * here we expose pure SQL builders.
 */

import type { ModuleSettings, QuotaDimension, QuotaState } from './types.js';

export interface QuotaDebitInput {
  apiKeyId: string;
  mode: 'fast' | 'stealth' | 'browser';
  requestsLimit: number; // copied into row on first lazy-create
  browserSecondsLimit: number;
  proxyBytesLimit: number;
  browserSecondsReservation: number; // settings.browser_seconds_reservation
  costEstimateAtDebit: number;
}

export type QuotaDebitOutcome =
  | {
      ok: true;
      debitId: string; // ULID, also written to ledger
      requestsUsed: number;
      browserSecondsUsed: number;
    }
  | {
      ok: false;
      dimension: QuotaDimension; // which dimension failed
    };

/**
 * Returns the SQL + bind values for the lazy-create + atomic debit
 * UPDATE. The caller runs this inside the single transaction that also
 * inserts the ledger row and audit-start row.
 *
 * Period boundaries: calendar months in UTC. We compute the [start,
 * end) once per call; if the row already exists for an older period
 * the CASE rolls it forward in the same statement (avoids a pre-check
 * race).
 */
export function buildDebitSql(
  input: QuotaDebitInput,
  now: Date = new Date(),
): { sql: string; values: unknown[]; periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const browserEstimate =
    input.mode === 'browser' ? input.browserSecondsReservation : 0;

  // INSERT … ON CONFLICT DO UPDATE handles three cases:
  //   1. No row exists: insert with limits + estimates (lazy-create).
  //   2. Row exists for current period: increment if within limits.
  //   3. Row exists for stale period: roll period + reset usage to estimates.
  //
  // The bound checks live in the WHERE-style clause of the DO UPDATE:
  // when a bound would be exceeded, we DO UPDATE with usage unchanged
  // and signal the failure via a sentinel. We can't conditionally fail
  // an INSERT … ON CONFLICT; instead we always set the row, then
  // filter via the RETURNING ... WHERE clause.
  //
  // For Phase 1 / Phase 2 we use the simpler form: lazy-insert if
  // missing, then a separate UPDATE … RETURNING. Two statements but
  // both inside the same transaction so atomicity holds.
  const sql = `
    -- Lazy-create the quota row if absent. Uses the CALLER-supplied
    -- limits rather than reading defaults from a config table — caller
    -- is the public-API handler which already has settings in memory.
    insert into fetch.quotas (
      api_key_id, period_start, period_end,
      requests_limit, requests_used,
      browser_seconds_limit, browser_seconds_used,
      proxy_bytes_limit, proxy_bytes_used,
      updated_at
    ) values ($1, $2, $3, $4, 0, $5, 0, $6, 0, now())
    on conflict (api_key_id) do nothing;

    -- Atomic debit + period roll-forward. The CASE rolls the period if
    -- the existing row is for an older month.
    update fetch.quotas
       set requests_used = (case
             when period_end <= $2 then 1
             else requests_used + 1
           end),
           browser_seconds_used = (case
             when period_end <= $2 then $7::numeric
             else browser_seconds_used + $7::numeric
           end),
           period_start = greatest(period_start, $2),
           period_end   = greatest(period_end,   $3),
           requests_limit = $4,
           browser_seconds_limit = $5,
           proxy_bytes_limit = $6,
           updated_at = now()
     where api_key_id = $1
       and (
         period_end <= $2
         or (
           requests_used + 1 <= requests_limit
           and (browser_seconds_used + $7::numeric) <= browser_seconds_limit
         )
       )
     returning requests_used, browser_seconds_used, proxy_bytes_used,
               requests_limit, browser_seconds_limit, proxy_bytes_limit;
  `;

  return {
    sql,
    values: [
      input.apiKeyId,
      periodStart,
      periodEnd,
      input.requestsLimit,
      input.browserSecondsLimit,
      input.proxyBytesLimit,
      browserEstimate,
    ],
    periodStart,
    periodEnd,
  };
}

/**
 * Reconcile actual values into the quota counter (spec §9.2.2).
 *
 * No bound check here — actuals are always applied. Bound enforcement
 * happens on the NEXT pre-debit. If proxy_bytes pushes over the limit,
 * the response still returns; the key is exhausted for `proxy_gb` going
 * forward.
 */
export function buildReconcileSql(
  apiKeyId: string,
  deltas: { browserSeconds: number; proxyBytes: number },
): { sql: string; values: unknown[] } {
  return {
    sql: `
      update fetch.quotas
         set browser_seconds_used = browser_seconds_used + $2::numeric,
             proxy_bytes_used     = proxy_bytes_used + $3::bigint,
             updated_at = now()
       where api_key_id = $1
       returning browser_seconds_used, proxy_bytes_used,
                 browser_seconds_limit, proxy_bytes_limit;
    `,
    values: [apiKeyId, deltas.browserSeconds, deltas.proxyBytes],
  };
}

/**
 * Read the current quota state for the GET /api/v1/fetch/quota endpoint
 * (spec §5.7). Returns null if the key has never made a request.
 */
export function buildQuotaReadSql(apiKeyId: string): {
  sql: string;
  values: unknown[];
} {
  return {
    sql: `
      select period_start, period_end,
             requests_limit, requests_used,
             browser_seconds_limit, browser_seconds_used,
             proxy_bytes_limit, proxy_bytes_used
        from fetch.quotas
       where api_key_id = $1;
    `,
    values: [apiKeyId],
  };
}

/**
 * Convert a DB row into the QuotaState shape returned by GET /quota.
 * Computes both bytes/seconds and unit-friendly forms (per §5.7).
 */
export function toQuotaState(
  row: {
    period_start: string;
    period_end: string;
    requests_limit: number;
    requests_used: number;
    browser_seconds_limit: number;
    browser_seconds_used: number;
    proxy_bytes_limit: number;
    proxy_bytes_used: number;
  },
  rateLimitRpm: number,
): QuotaState {
  return {
    period_start: row.period_start,
    period_end: row.period_end,
    requests: {
      limit: row.requests_limit,
      used: row.requests_used,
      remaining: Math.max(0, row.requests_limit - row.requests_used),
    },
    browser_seconds: {
      limit: row.browser_seconds_limit,
      used: row.browser_seconds_used,
      remaining: Math.max(0, row.browser_seconds_limit - row.browser_seconds_used),
    },
    browser_minutes: {
      limit: row.browser_seconds_limit / 60,
      used: row.browser_seconds_used / 60,
      remaining: Math.max(0, (row.browser_seconds_limit - row.browser_seconds_used) / 60),
    },
    proxy_bytes: {
      limit: row.proxy_bytes_limit,
      used: row.proxy_bytes_used,
      remaining: Math.max(0, row.proxy_bytes_limit - row.proxy_bytes_used),
    },
    proxy_gb: {
      limit: row.proxy_bytes_limit / 1e9,
      used: row.proxy_bytes_used / 1e9,
      remaining: Math.max(0, (row.proxy_bytes_limit - row.proxy_bytes_used) / 1e9),
    },
    rate_per_minute: { limit: rateLimitRpm },
  };
}

/**
 * Default-limits resolver: takes module settings, returns the per-row
 * limit triple in the units the DB expects.
 */
export function defaultLimits(settings: ModuleSettings): {
  requests_limit: number;
  browser_seconds_limit: number;
  proxy_bytes_limit: number;
} {
  return {
    requests_limit: settings.default_quota_requests_per_month,
    browser_seconds_limit: settings.default_quota_browser_minutes_per_month * 60,
    proxy_bytes_limit: settings.default_quota_proxy_gb_per_month * 1_000_000_000,
  };
}
