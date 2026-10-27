import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_ROWS_PER_CALL,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TIME_BUDGET_MS,
  pruneJobLogs,
  resolveMaxRowsPerCall,
  resolveRetentionDays,
  resolveTimeBudgetMs,
} from '../prune-job-logs-handler.js';

function fakeRpc(batches) {
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    const next = batches.shift();
    if (next instanceof Error) return { data: null, error: { message: next.message } };
    return { data: next === undefined ? [{ jobs_touched: 0, rows_deleted: 0 }] : [next], error: null };
  };
  return { rpc, calls };
}

test('retention: job data wins, then env, then the default', () => {
  assert.equal(resolveRetentionDays({ retention_days: 30 }, { SCRAPERS_LOG_RETENTION_DAYS: '14' }), 30);
  assert.equal(resolveRetentionDays({}, { SCRAPERS_LOG_RETENTION_DAYS: '14' }), 14);
  assert.equal(resolveRetentionDays({}, {}), DEFAULT_RETENTION_DAYS);
  assert.equal(resolveRetentionDays(undefined, undefined), DEFAULT_RETENTION_DAYS);
});

test('retention: anything that is not an integer >= 1 is ignored, never trusted', () => {
  for (const bad of [0, -1, 1.5, 'abc', '', null, NaN, Infinity, '0', '-7', {}, []]) {
    assert.equal(resolveRetentionDays({ retention_days: bad }, {}), DEFAULT_RETENTION_DAYS, `data ${String(bad)}`);
    assert.equal(resolveRetentionDays({}, { SCRAPERS_LOG_RETENTION_DAYS: bad }), DEFAULT_RETENTION_DAYS, `env ${String(bad)}`);
  }
  assert.equal(resolveRetentionDays({ retention_days: '7' }, {}), 7, 'numeric strings from env-style config are fine');
});

test('rows per call is capped at the function ceiling and defaults otherwise', () => {
  assert.equal(resolveMaxRowsPerCall({ max_rows_per_call: 200000 }), 200000);
  assert.equal(resolveMaxRowsPerCall({ max_rows_per_call: 1000000 }), 1000000);
  assert.equal(resolveMaxRowsPerCall({ max_rows_per_call: 1000001 }), DEFAULT_MAX_ROWS_PER_CALL);
  assert.equal(resolveMaxRowsPerCall({ max_rows_per_call: 0 }), DEFAULT_MAX_ROWS_PER_CALL);
  assert.equal(resolveMaxRowsPerCall({}), DEFAULT_MAX_ROWS_PER_CALL);
  assert.equal(resolveTimeBudgetMs({}), DEFAULT_TIME_BUDGET_MS);
  assert.equal(resolveTimeBudgetMs({ time_budget_ms: 1 }), 1);
  assert.equal(resolveTimeBudgetMs({ time_budget_ms: 60 * 60 * 1000 }), 60 * 60 * 1000);
  assert.equal(resolveTimeBudgetMs({ time_budget_ms: 60 * 60 * 1000 + 1 }), DEFAULT_TIME_BUDGET_MS, 'a payload cannot pin the worker past an hour');
});

test('loops until a call deletes nothing and sums the rows', async () => {
  const { rpc, calls } = fakeRpc([
    { jobs_touched: 10, rows_deleted: 20000 },
    { jobs_touched: 10, rows_deleted: 20000 },
    { jobs_touched: 3, rows_deleted: 412 },
    // then the implicit { 0, 0 }
  ]);
  const result = await pruneJobLogs({ rpc, retentionDays: 7, maxRowsPerCall: 20000, now: () => 0 });
  assert.deepEqual(result, { rows_deleted: 40412, calls: 4, exhausted: true });
  assert.equal(calls.length, 4);
  for (const c of calls) {
    assert.equal(c.fn, 'scrapers_prune_job_logs');
    assert.deepEqual(c.args, { p_retention_days: 7, p_max_rows: 20000 });
  }
});

test('a table with nothing to prune costs exactly one call', async () => {
  const { rpc, calls } = fakeRpc([]);
  const result = await pruneJobLogs({ rpc, retentionDays: 7 });
  assert.deepEqual(result, { rows_deleted: 0, calls: 1, exhausted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.p_max_rows, DEFAULT_MAX_ROWS_PER_CALL);
});

test('stops when the time budget is spent and reports exhausted=false', async () => {
  const { rpc, calls } = fakeRpc([
    { jobs_touched: 10, rows_deleted: 1 },
    { jobs_touched: 10, rows_deleted: 1 },
    { jobs_touched: 10, rows_deleted: 1 },
    { jobs_touched: 10, rows_deleted: 1 },
  ]);
  let t = 0;
  const now = () => { t += 1000; return t; }; // 1 s per observation
  const result = await pruneJobLogs({ rpc, retentionDays: 7, timeBudgetMs: 2000, now });
  assert.equal(result.exhausted, false);
  assert.ok(calls.length < 4, `should stop early, made ${calls.length} calls`);
  assert.equal(result.rows_deleted, calls.length);
});

test('an rpc error aborts the loop and is surfaced with the call count', async () => {
  const { rpc } = fakeRpc([{ jobs_touched: 10, rows_deleted: 5 }, new Error('permission denied for function')]);
  await assert.rejects(
    () => pruneJobLogs({ rpc, retentionDays: 7, now: () => 0 }),
    /scrapers_prune_job_logs failed after 1 calls: permission denied/,
  );
});

test('tolerates a scalar row shape as well as the array PostgREST returns', async () => {
  let n = 0;
  const rpc = async () => {
    n += 1;
    return { data: n === 1 ? { jobs_touched: 1, rows_deleted: 30 } : { jobs_touched: 0, rows_deleted: 0 }, error: null };
  };
  const result = await pruneJobLogs({ rpc, retentionDays: 7, now: () => 0 });
  assert.deepEqual(result, { rows_deleted: 30, calls: 2, exhausted: true });
});
