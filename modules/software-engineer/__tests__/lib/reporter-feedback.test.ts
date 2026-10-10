// @ts-nocheck
// Unit coverage for lib/reporter-feedback.ts (migration 029): the reporter-safe question/answer surface
// that is deliberately separate from se_decisions. Focuses on the two invariants the spec calls out —
// "a replayed/stale answer cannot double-resume a run" and "duplicate reporters retain independent
// histories" is exercised at the link layer — using a small stateful in-memory fake of the Postgrest
// client shape these functions call.
import { describe, it, expect } from 'vitest';
import {
  createOrSupersedeReporterQuestion,
  answerReporterQuestion,
  linkReporterReport,
} from '../../lib/reporter-feedback.js';

function makeFakeDb(seed = {}) {
  const tables = {
    se_reporter_questions: [],
    se_reporter_answers: [],
    se_reporter_links: [],
    se_runs: [{ id: 'run-1', site_id: 'site-1', updated_at: new Date().toISOString() }],
    se_messages: [],
    ...seed,
  };
  let idCounter = 0;

  function from(table) {
    const filters = [];
    let orderCol = null;
    let orderAsc = true;
    let limitN = null;
    let op = 'select';
    let payload = null;
    let upsertConflict = null;

    const api = {
      select() { return api; },
      insert(row) { op = 'insert'; payload = row; return api; },
      update(row) { op = 'update'; payload = row; return api; },
      upsert(row, opts) { op = 'upsert'; payload = row; upsertConflict = opts?.onConflict; return api; },
      eq(col, val) { filters.push((r) => r[col] === val); return api; },
      gt(col, val) { filters.push((r) => r[col] > val); return api; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return api; },
      order(col, opts) { orderCol = col; orderAsc = !(opts && opts.ascending === false); return api; },
      limit(n) { limitN = n; return api; },
      maybeSingle() { return Promise.resolve(exec(true)); },
      single() { return Promise.resolve(exec(true)); },
      then(onF, onR) { return Promise.resolve(exec(false)).then(onF, onR); },
    };

    function matches(row) { return filters.every((f) => f(row)); }

    function exec(wantSingle) {
      const arr = tables[table];
      if (op === 'insert') {
        const row = { id: `${table}-${++idCounter}`, created_at: new Date().toISOString(), ...payload };
        arr.push(row);
        return wantSingle ? { data: row, error: null } : { data: [row], error: null };
      }
      if (op === 'upsert') {
        const keys = String(upsertConflict ?? '').split(',');
        const existing = arr.find((r) => keys.every((k) => r[k] === payload[k]));
        if (existing) { Object.assign(existing, payload); return wantSingle ? { data: existing, error: null } : { data: [existing], error: null }; }
        const row = { id: `${table}-${++idCounter}`, created_at: new Date().toISOString(), ...payload };
        arr.push(row);
        return wantSingle ? { data: row, error: null } : { data: [row], error: null };
      }
      if (op === 'update') {
        const matched = arr.filter(matches);
        matched.forEach((r) => Object.assign(r, payload));
        return wantSingle ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
      }
      let result = arr.filter(matches);
      if (orderCol) result = [...result].sort((a, b) => (orderAsc ? (a[orderCol] > b[orderCol] ? 1 : -1) : (a[orderCol] < b[orderCol] ? 1 : -1)));
      if (limitN != null) result = result.slice(0, limitN);
      return wantSingle ? { data: result[0] ?? null, error: null } : { data: result, error: null };
    }

    return api;
  }

  return { from, __tables: tables };
}

describe('createOrSupersedeReporterQuestion', () => {
  it('supersedes the prior pending question and increments revision', async () => {
    const db = makeFakeDb();
    const first = await createOrSupersedeReporterQuestion(db, {
      runId: 'run-1', siteId: 'site-1', phase: 'review', question: 'Does this match?', kind: 'choice',
      options: [{ id: 'confirm', label: 'Yes' }, { id: 'change', label: 'No' }], summary: 'draft v1',
    });
    expect(first.revision).toBe(1);
    expect(first.status).toBe('pending');

    const second = await createOrSupersedeReporterQuestion(db, {
      runId: 'run-1', siteId: 'site-1', phase: 'review', question: 'Does this match now?', kind: 'text', summary: 'draft v2',
    });
    expect(second.revision).toBe(2);

    const stale = db.__tables.se_reporter_questions.find((q) => q.id === first.id);
    expect(stale.status).toBe('superseded');
    const live = db.__tables.se_reporter_questions.find((q) => q.id === second.id);
    expect(live.status).toBe('pending');
  });
});

describe('answerReporterQuestion', () => {
  async function seedQuestion(db) {
    return createOrSupersedeReporterQuestion(db, {
      runId: 'run-1', siteId: 'site-1', phase: 'review', question: 'Does this match?', kind: 'choice',
      options: [{ id: 'confirm', label: 'Yes, that’s it' }, { id: 'change', label: 'Not quite' }], summary: 'draft v1',
    });
  }

  it('accepts a correctly-revisioned answer, marks it answered, and posts a reporter message', async () => {
    const db = makeFakeDb();
    const q = await seedQuestion(db);
    const result = await answerReporterQuestion(db, {
      questionId: q.id, revision: q.revision, answer: { optionId: 'confirm' }, idempotencyKey: 'key-1',
    });
    expect(result.ok).toBe(true);
    expect(result.replayed).toBe(false);
    const updated = db.__tables.se_reporter_questions.find((r) => r.id === q.id);
    expect(updated.status).toBe('answered');
    expect(db.__tables.se_messages).toHaveLength(1);
    expect(db.__tables.se_messages[0].role).toBe('reporter');
    expect(db.__tables.se_messages[0].content).toContain('confirmed');
  });

  it('rejects a stale revision (superseded question) with 409 stale_question — no double-resume', async () => {
    const db = makeFakeDb();
    const q1 = await seedQuestion(db);
    const q2 = await createOrSupersedeReporterQuestion(db, {
      runId: 'run-1', siteId: 'site-1', phase: 'review', question: 'Updated question', kind: 'text', summary: 'draft v2',
    });
    // A client that only ever saw q1's revision tries to answer against it after it was superseded.
    const result = await answerReporterQuestion(db, {
      questionId: q1.id, revision: q1.revision, answer: { text: 'too late' }, idempotencyKey: 'key-2',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error.code).toBe('already_answered');
    expect(db.__tables.se_messages).toHaveLength(0);
    // q2 is untouched and still answerable.
    expect(db.__tables.se_reporter_questions.find((r) => r.id === q2.id).status).toBe('pending');
  });

  it('replays an identical retry (same idempotency key) as a no-op instead of a second answer', async () => {
    const db = makeFakeDb();
    const q = await seedQuestion(db);
    const first = await answerReporterQuestion(db, { questionId: q.id, revision: q.revision, answer: { optionId: 'confirm' }, idempotencyKey: 'key-3' });
    const second = await answerReporterQuestion(db, { questionId: q.id, revision: q.revision, answer: { optionId: 'confirm' }, idempotencyKey: 'key-3' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(db.__tables.se_reporter_answers).toHaveLength(1);
    expect(db.__tables.se_messages).toHaveLength(1);
  });

  it('rejects answering an already-answered question with a different idempotency key', async () => {
    const db = makeFakeDb();
    const q = await seedQuestion(db);
    await answerReporterQuestion(db, { questionId: q.id, revision: q.revision, answer: { optionId: 'confirm' }, idempotencyKey: 'key-4' });
    const retry = await answerReporterQuestion(db, { questionId: q.id, revision: q.revision, answer: { optionId: 'change' }, idempotencyKey: 'key-5' });
    expect(retry.ok).toBe(false);
    expect(retry.status).toBe(409);
    expect(retry.error.code).toBe('already_answered');
  });
});

describe('linkReporterReport', () => {
  it('is idempotent on (externalSystem, externalReportId)', async () => {
    const db = makeFakeDb();
    const first = await linkReporterReport(db, {
      runId: 'run-1', siteId: 'site-1', externalSystem: 'health_core', externalReportId: 'report-1', externalPersonId: 'person-1',
    });
    const second = await linkReporterReport(db, {
      runId: 'run-1', siteId: 'site-1', externalSystem: 'health_core', externalReportId: 'report-1', externalPersonId: 'person-1', isPrimary: false,
    });
    expect(db.__tables.se_reporter_links).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.is_primary).toBe(false);
  });

  it('gives a duplicate reporter their own link row pointing at the same run', async () => {
    const db = makeFakeDb();
    await linkReporterReport(db, { runId: 'run-1', siteId: 'site-1', externalSystem: 'health_core', externalReportId: 'report-1', externalPersonId: 'person-1' });
    await linkReporterReport(db, { runId: 'run-1', siteId: 'site-1', externalSystem: 'health_core', externalReportId: 'report-2', externalPersonId: 'person-2', isPrimary: false });
    expect(db.__tables.se_reporter_links).toHaveLength(2);
    expect(new Set(db.__tables.se_reporter_links.map((l) => l.run_id)).size).toBe(1);
  });
});
