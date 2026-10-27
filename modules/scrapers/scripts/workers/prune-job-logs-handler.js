/**
 * BullMQ handler: scraper:prune-logs.
 *
 * Deletes scrapers_job_logs rows for jobs older than the retention window.
 * Scheduled daily by the `scrapers-prune-job-logs` cron in index.ts; can
 * also be enqueued by hand with a different `retention_days`.
 *
 * The deletion itself lives in the SQL function scrapers_prune_job_logs
 * (migrations/023_job_logs_retention.sql), which deletes a bounded number
 * of rows per call. This handler just loops it until the function reports
 * nothing deleted, or until a wall-clock budget runs out, so a first run
 * against a 160M-row table is a series of sub-second transactions rather
 * than one that holds locks for an hour. Whatever is left is picked up by
 * the next scheduled run.
 *
 * Each call has to finish inside PostgREST's 8 s statement timeout, which
 * is why the batch is counted in rows and defaults to 20k.
 *
 * Payload (all optional):
 *   {
 *     retention_days?: number,     // default SCRAPERS_LOG_RETENTION_DAYS env, then 7
 *     max_rows_per_call?: number,  // default 20000, max 1000000 (enforced by the function too)
 *     time_budget_ms?: number,     // default 10 minutes, max 1 hour
 *   }
 */

export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_MAX_ROWS_PER_CALL = 20000;
export const DEFAULT_TIME_BUDGET_MS = 10 * 60 * 1000;
const MAX_ROWS_PER_CALL_CEILING = 1000000;
// A payload cannot pin the concurrency-1 worker for more than an hour; the
// nightly cron picks up whatever is left.
const TIME_BUDGET_CEILING_MS = 60 * 60 * 1000;

const HANDLER_NAME = '[scraper:prune-logs]';

function positiveInt(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

/**
 * Retention window in days. Job data wins, then the
 * SCRAPERS_LOG_RETENTION_DAYS env var, then the default. Anything that is
 * not an integer >= 1 is ignored rather than trusted, so a typo can never
 * turn into "delete everything".
 */
export function resolveRetentionDays(data, env = process.env) {
  return (
    positiveInt(data?.retention_days) ??
    positiveInt(env?.SCRAPERS_LOG_RETENTION_DAYS) ??
    DEFAULT_RETENTION_DAYS
  );
}

export function resolveMaxRowsPerCall(data) {
  return positiveInt(data?.max_rows_per_call, { max: MAX_ROWS_PER_CALL_CEILING }) ?? DEFAULT_MAX_ROWS_PER_CALL;
}

export function resolveTimeBudgetMs(data) {
  return positiveInt(data?.time_budget_ms, { max: TIME_BUDGET_CEILING_MS }) ?? DEFAULT_TIME_BUDGET_MS;
}

/**
 * Loop scrapers_prune_job_logs until it reports no rows deleted or the time
 * budget is spent. `rpc` is the supabase-js rpc function so tests can pass
 * a fake.
 */
export async function pruneJobLogs({
  rpc,
  retentionDays,
  maxRowsPerCall = DEFAULT_MAX_ROWS_PER_CALL,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  now = Date.now,
  log = () => {},
}) {
  const startedAt = now();
  let rowsDeleted = 0;
  let calls = 0;

  for (;;) {
    const { data, error } = await rpc('scrapers_prune_job_logs', {
      p_retention_days: retentionDays,
      p_max_rows: maxRowsPerCall,
    });
    if (error) {
      throw new Error(`${HANDLER_NAME} scrapers_prune_job_logs failed after ${calls} calls: ${error.message}`);
    }
    calls += 1;

    const row = Array.isArray(data) ? data[0] : data;
    const rd = Number(row?.rows_deleted ?? 0);
    rowsDeleted += rd;

    if (rd === 0) {
      return { rows_deleted: rowsDeleted, calls, exhausted: true };
    }

    if (calls % 50 === 0) {
      log(`${HANDLER_NAME} progress: calls=${calls} rows=${rowsDeleted}`);
    }

    if (now() - startedAt >= timeBudgetMs) {
      return { rows_deleted: rowsDeleted, calls, exhausted: false };
    }
  }
}

let _supabase = null;
// supabase-js is imported lazily so the pure helpers above can be unit
// tested without the module's node_modules installed.
async function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(`${HANDLER_NAME} missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY`);
  }
  const { createClient } = await import('@supabase/supabase-js');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

export default async function handler(job) {
  const data = job?.data ?? {};
  const retentionDays = resolveRetentionDays(data);
  const maxRowsPerCall = resolveMaxRowsPerCall(data);
  const timeBudgetMs = resolveTimeBudgetMs(data);
  const log = (msg) => {
    console.log(msg);
    if (typeof job?.log === 'function') job.log(msg).catch(() => {});
  };

  log(`${HANDLER_NAME} start: retention_days=${retentionDays} max_rows_per_call=${maxRowsPerCall} time_budget_ms=${timeBudgetMs}`);

  const supabase = await getSupabase();
  const result = await pruneJobLogs({
    rpc: (fn, args) => supabase.rpc(fn, args),
    retentionDays,
    maxRowsPerCall,
    timeBudgetMs,
    log,
  });

  log(
    `${HANDLER_NAME} done: rows=${result.rows_deleted} calls=${result.calls} ` +
    `${result.exhausted ? 'nothing left to prune' : 'time budget spent, remainder on next run'}`,
  );

  return { retention_days: retentionDays, ...result };
}
