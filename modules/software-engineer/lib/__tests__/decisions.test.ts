// @ts-nocheck — vitest harness; the lib modules are @ts-nocheck'd already.
//
// Exercises the shared decision-persistence and resume/approve helpers behind issue #52:
//   - createOrSupersedeDecision: supersede-then-insert, so a run never carries two pending decisions.
//   - resumeRunForDecision: the CAS-guarded resume shared by /runs/:id/resume and the new answer route.
//   - approveArchitecture: the CAS-guarded architecture approve shared the same way.
import { describe, it, expect } from 'vitest';
import { createOrSupersedeDecision, resumeRunForDecision, approveArchitecture, ARCHITECTURE_DECISION_OPTIONS } from '../decisions.js';

function mockSupabase(config: any = {}) {
  const calls = { inserts: [] as any[], updates: [] as any[] };
  const resolve = (state: any) => {
    const { table, op } = state;
    if (table === 'se_runs' && op === 'update') {
      return { data: config.updateError ? null : (config.updateRaced ? [] : [{ id: 'run-1' }]), error: config.updateError ?? null };
    }
    if (table === 'se_phases' && state.selectOpts?.head) return { count: config.attemptCount ?? 0, error: null };
    if (table === 'se_decisions' && op === 'insert') return { data: config.insertError ? null : { id: 'decision-1', status: 'pending' }, error: config.insertError ?? null };
    return { data: null, error: null };
  };
  const from = (table: string) => {
    const state: any = { table, op: 'select', selectOpts: undefined };
    const b: any = {
      select(_s: unknown, opts: unknown) { state.selectOpts = opts; return b; },
      insert(row: unknown) { state.op = 'insert'; calls.inserts.push({ table, row }); return b; },
      update(row: unknown) { state.op = 'update'; calls.updates.push({ table, row }); return b; },
      eq() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
      single() { return Promise.resolve(resolve(state)); },
      maybeSingle() { return Promise.resolve(resolve(state)); },
      then(onF: any, onR: any) { return Promise.resolve(resolve(state)).then(onF, onR); },
    };
    return b;
  };
  return { from, __calls: calls };
}

const RUN = { id: 'run-1', site_id: 'site-1', project_id: 'proj-1', status: 'blocked', issue_number: null };

describe('createOrSupersedeDecision', () => {
  it('supersedes any pending decision for the run before inserting the new one', async () => {
    const supa = mockSupabase();
    await createOrSupersedeDecision(supa, {
      runId: 'run-1', projectId: 'proj-1', siteId: 'site-1', phase: 'verify',
      question: 'security: bad thing', kind: 'text',
    });
    const supersede = supa.__calls.updates.find((c: any) => c.table === 'se_decisions');
    expect(supersede.row).toEqual({ status: 'superseded' });
    const insert = supa.__calls.inserts.find((c: any) => c.table === 'se_decisions');
    expect(insert.row).toMatchObject({ run_id: 'run-1', project_id: 'proj-1', site_id: 'site-1', phase: 'verify', question: 'security: bad thing', kind: 'text', status: 'pending' });
  });

  it('throws when the insert fails', async () => {
    const supa = mockSupabase({ insertError: { message: 'db down' } });
    await expect(createOrSupersedeDecision(supa, {
      runId: 'run-1', projectId: 'proj-1', siteId: 'site-1', phase: 'verify', question: 'q', kind: 'text',
    })).rejects.toBeTruthy();
  });
});

describe('resumeRunForDecision', () => {
  it('returns a no_phase error when resumePhase is falsy', async () => {
    const supa = mockSupabase();
    const result = await resumeRunForDecision(supa, {}, RUN, null);
    expect(result).toEqual({ status: 409, error: { code: 'no_phase', message: 'Could not determine which phase to resume.' } });
  });

  it('returns 409 state_changed when the CAS update loses the race', async () => {
    const supa = mockSupabase({ updateRaced: true });
    const result = await resumeRunForDecision(supa, {}, RUN, 'implement');
    expect(result.status).toBe(409);
    expect(result.error.code).toBe('state_changed');
  });

  it('returns 500 when the update errors', async () => {
    const supa = mockSupabase({ updateError: { message: 'db down' } });
    const result = await resumeRunForDecision(supa, {}, RUN, 'implement');
    expect(result.status).toBe(500);
  });

  it('resumes, increments the attempt, and inserts a note when note is a plain string', async () => {
    const enqueued: any[] = [];
    const supa = mockSupabase({ attemptCount: 1 });
    const result = await resumeRunForDecision(supa, {}, RUN, 'implement', {
      note: 'answered', actorId: 'admin-1', enqueueJob: async (...a: any[]) => { enqueued.push(a); return { id: 'job-1' }; },
    });
    expect(result).toEqual({ resumed: true, phase: 'implement', attempt: 2 });
    const msg = supa.__calls.inserts.find((c: any) => c.table === 'se_messages');
    expect(msg.row.content).toBe('answered');
    expect(enqueued).toEqual([[
      'se', 'software-engineer:implement', { runId: 'run-1', attempt: 2 },
      { jobId: 'se-run-run-1-implement', removeOnComplete: true, removeOnFail: true },
    ]]);
  });

  it('calls note as a function with the computed next attempt', async () => {
    const supa = mockSupabase({ attemptCount: 0 });
    let seenAttempt: number | null = null;
    await resumeRunForDecision(supa, {}, RUN, 'spec', {
      note: (attempt: number) => { seenAttempt = attempt; return `resumed at attempt ${attempt}`; },
      enqueueJob: async () => ({ id: 'job-1' }),
    });
    expect(seenAttempt).toBe(1);
    const msg = supa.__calls.inserts.find((c: any) => c.table === 'se_messages');
    expect(msg.row.content).toBe('resumed at attempt 1');
  });

  it('threads extraJobData through to the enqueued phase job', async () => {
    const enqueued: any[] = [];
    const supa = mockSupabase({ attemptCount: 0 });
    await resumeRunForDecision(supa, {}, RUN, 'spec', {
      extraJobData: { objections: ['a', 'b'] },
      enqueueJob: async (...a: any[]) => { enqueued.push(a); return { id: 'job-1' }; },
    });
    expect(enqueued[0][2]).toEqual({ runId: 'run-1', attempt: 1, objections: ['a', 'b'] });
  });
});

describe('approveArchitecture', () => {
  it('returns 409 state_changed when the CAS update loses the race', async () => {
    const supa = mockSupabase({ updateRaced: true });
    const result = await approveArchitecture(supa, {}, { ...RUN, status: 'architecture_in_review' });
    expect(result.status).toBe(409);
    expect(result.error.code).toBe('state_changed');
  });

  it('enqueues implement and inserts a system message on success', async () => {
    const enqueued: any[] = [];
    const supa = mockSupabase();
    const result = await approveArchitecture(supa, {}, { ...RUN, status: 'architecture_in_review' }, {
      actorId: 'admin-1', enqueueJob: async (...a: any[]) => { enqueued.push(a); return { id: 'job-1' }; },
    });
    expect(result).toEqual({ approved: true, resuming: true });
    expect(enqueued).toEqual([[
      'se', 'software-engineer:implement', { runId: 'run-1' },
      { jobId: 'se-run-run-1-implement', removeOnComplete: true, removeOnFail: true },
    ]]);
    const msg = supa.__calls.inserts.find((c: any) => c.table === 'se_messages');
    expect(msg.row.content).toContain('Architecture approved');
  });
});

describe('ARCHITECTURE_DECISION_OPTIONS', () => {
  it('exposes exactly the three fixed options with stable ids', () => {
    expect(ARCHITECTURE_DECISION_OPTIONS.map((o) => o.id)).toEqual(['approve', 'request_changes', 'reject']);
  });
});
