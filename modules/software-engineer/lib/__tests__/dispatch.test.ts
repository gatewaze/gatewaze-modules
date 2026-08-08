// @ts-nocheck — vitest harness; the lib modules are @ts-nocheck'd already.
//
// Exercises archiveAndReplace (issue #52 §... shared infra, not wired to a UI action yet): atomically
// archive a run and insert its replacement, rolling the archive back if the insert fails, and
// reporting a dispatch failure explicitly instead of swallowing it.
import { describe, it, expect } from 'vitest';
import { archiveAndReplace } from '../dispatch.js';

function mockSupabase(config: any = {}) {
  const calls = { inserts: [] as any[], updates: [] as any[] };
  const resolve = (state: any) => {
    const { table, op } = state;
    if (table === 'se_runs' && op === 'select') return { data: config.old ?? null, error: null };
    if (table === 'se_runs' && op === 'update') {
      return { data: config.archiveError ? null : (config.archiveRaced ? [] : [{ id: 'old-run' }]), error: config.archiveError ?? null };
    }
    if (table === 'se_runs' && op === 'insert') {
      return { data: config.insertError ? null : { id: 'new-run', project_id: config.old?.project_id ?? 'proj-1' }, error: config.insertError ?? null };
    }
    // dispatchProject's internal getProject() lookup — disable intake so it short-circuits at 0
    // started without needing to mock the rest of dispatchProject's query chain.
    if (table === 'se_projects') return { data: { intake_enabled: false }, error: null };
    return { data: null, error: null };
  };
  const from = (table: string) => {
    const state: any = { table, op: 'select' };
    const b: any = {
      select() { return b; },
      insert(row: unknown) { state.op = 'insert'; calls.inserts.push({ table, row }); return b; },
      update(row: unknown) { state.op = 'update'; calls.updates.push({ table, row }); return b; },
      eq() { return b; }, is() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
      single() { return Promise.resolve(resolve(state)); },
      maybeSingle() { return Promise.resolve(resolve(state)); },
      then(onF: any, onR: any) { return Promise.resolve(resolve(state)).then(onF, onR); },
    };
    return b;
  };
  return { from, __calls: calls };
}

const OLD = { id: 'old-run', project_id: 'proj-1', archived_at: null };

describe('archiveAndReplace', () => {
  it('returns ok:false when the old run does not exist', async () => {
    const supa = mockSupabase({ old: null });
    const result = await archiveAndReplace(supa, {}, 'old-run', { project_id: 'proj-1' });
    expect(result).toEqual({ ok: false, reason: 'old run not found' });
  });

  it('returns ok:false when the old run is already archived', async () => {
    const supa = mockSupabase({ old: { ...OLD, archived_at: '2026-01-01T00:00:00Z' } });
    const result = await archiveAndReplace(supa, {}, 'old-run', { project_id: 'proj-1' });
    expect(result).toEqual({ ok: false, reason: 'old run already archived' });
  });

  it('returns ok:false when the CAS archive-guard loses the race', async () => {
    const supa = mockSupabase({ old: OLD, archiveRaced: true });
    const result = await archiveAndReplace(supa, {}, 'old-run', { project_id: 'proj-1' });
    expect(result).toEqual({ ok: false, reason: 'old run already archived' });
  });

  it('returns ok:false when the archive update errors', async () => {
    const supa = mockSupabase({ old: OLD, archiveError: { message: 'db down' } });
    const result = await archiveAndReplace(supa, {}, 'old-run', { project_id: 'proj-1' });
    expect(result).toEqual({ ok: false, reason: 'archive failed' });
  });

  it('rolls back the archive when the replacement insert fails', async () => {
    const supa = mockSupabase({ old: OLD, insertError: { message: 'constraint violation' } });
    const result = await archiveAndReplace(supa, {}, 'old-run', { project_id: 'proj-1' });
    expect(result).toEqual({ ok: false, reason: 'insert failed' });
    const rollback = supa.__calls.updates.find((c: any) => c.table === 'se_runs' && c.row.archived_at === null);
    expect(rollback).toBeTruthy();
  });

  it('archives the old run, inserts the new one, and dispatches the project on success', async () => {
    const supa = mockSupabase({ old: OLD });
    const result = await archiveAndReplace(supa, {}, 'old-run', { project_id: 'proj-1', issue_number: 42 });
    expect(result).toEqual({ ok: true, oldRunId: 'old-run', newRun: { id: 'new-run', project_id: 'proj-1' }, started: 0 });
    const archiveCall = supa.__calls.updates.find((c: any) => c.table === 'se_runs' && typeof c.row.archived_at === 'string');
    expect(archiveCall).toBeTruthy();
    const insertCall = supa.__calls.inserts.find((c: any) => c.table === 'se_runs');
    expect(insertCall.row).toMatchObject({ status: 'queued', project_id: 'proj-1', issue_number: 42 });
  });
});
