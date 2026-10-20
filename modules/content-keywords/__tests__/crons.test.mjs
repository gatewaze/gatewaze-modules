// The chart worker only runs jobs that land on the shared 'jobs' queue, so the
// drain must be scheduled by a crons[] tick whose data.kind names a declared
// worker. recompute and scan-stale re-evaluate whole tables and must stay
// unscheduled until that is decided on purpose.
//
// Run: node --experimental-strip-types --test __tests__/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mod from '../index.ts';

const crons = mod.crons ?? [];
const workerNames = new Set((mod.workers ?? []).map((w) => w.name));

test('schedules the drain on the shared jobs queue', () => {
  const drain = crons.find((c) => c.data?.kind === 'content-keywords:drain-queue');
  assert.ok(drain, 'no cron for content-keywords:drain-queue');
  assert.equal(drain.queue, 'jobs');
  assert.equal(typeof drain.schedule?.every, 'number');
  assert.ok(drain.schedule.every >= 5_000, 'tick faster than 5s');
});

test('every cron kind names a declared worker', () => {
  for (const c of crons) assert.ok(workerNames.has(c.data?.kind), `${c.name} -> ${c.data?.kind} has no worker`);
});

test('recompute and scan-stale are not scheduled', () => {
  const kinds = crons.map((c) => c.data?.kind);
  assert.ok(!kinds.includes('content-keywords:recompute'));
  assert.ok(!kinds.includes('content-keywords:scan-stale'));
});
