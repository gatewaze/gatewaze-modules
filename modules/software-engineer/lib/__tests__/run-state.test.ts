// @ts-nocheck — vitest harness; the lib modules are @ts-nocheck'd already.
//
// Exercises two resume-related (issue #36) behaviors in run-state.ts:
//   - recordPhaseStart's explicit `attempt` param, which lets a resumed phase's new attempt row
//     coexist with the prior FAILED attempt's row instead of clobbering it (unique (run_id, phase,
//     attempt) constraint).
//   - drainPendingAdminMessages, the gate-mailbox drain that closes the resume cold-start race
//     (§3.3): only active for attempt > 1, so it never re-surfaces ordinary already-consumed live
//     chat as a fake "admin note" on every phase transition.
import { describe, it, expect } from 'vitest';
import { recordPhaseStart, drainPendingAdminMessages, recomputeRunCost } from '../run-state.js';

// Chainable supabase double. `upserts`/`updates` record every call for assertion; `select` chains
// resolve via the `config` the test passes in.
function mockSupabase(config: any = {}) {
  const upserts: any[] = [];
  const updates: any[] = [];
  const from = (table: string) => {
    const state: any = { table };
    const b: any = {
      select() { return b; },
      upsert(row: unknown, opts: unknown) { upserts.push({ table, row, opts }); return Promise.resolve({ data: null, error: null }); },
      update(row: unknown) { updates.push({ table, row }); return b; },
      eq() { return b; }, is() { return b; }, in() { return b; }, order() { return b; },
      then(onF: any, onR: any) {
        if (table === 'se_messages') return Promise.resolve({ data: config.pending ?? [], error: null }).then(onF, onR);
        if (table === 'se_phases') return Promise.resolve({ data: config.phases ?? null, error: null }).then(onF, onR);
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return b;
  };
  return { from, __upserts: upserts, __updates: updates };
}

const RUN = { id: 'run-1', site_id: 'site-1' };

describe('recordPhaseStart', () => {
  it('defaults to attempt 1 when no attempt is passed', async () => {
    const supa = mockSupabase();
    await recordPhaseStart(supa, RUN, 'implement');
    expect(supa.__upserts).toHaveLength(1);
    expect(supa.__upserts[0].row).toMatchObject({ run_id: 'run-1', phase: 'implement', attempt: 1 });
    expect(supa.__upserts[0].opts).toEqual({ onConflict: 'run_id,phase,attempt' });
  });

  it('upserts an explicit incremented attempt without touching attempt 1', async () => {
    const supa = mockSupabase();
    await recordPhaseStart(supa, RUN, 'implement', 2);
    expect(supa.__upserts).toHaveLength(1);
    expect(supa.__upserts[0].row).toMatchObject({ run_id: 'run-1', phase: 'implement', attempt: 2 });
    // The upsert targets (run_id, phase, attempt) — attempt 2 is a distinct key from attempt 1, so the
    // prior FAILED row for attempt 1 is never touched by this call.
    expect(supa.__upserts[0].row.attempt).not.toBe(1);
  });
});

describe('drainPendingAdminMessages', () => {
  it('no-ops for attempt 1 (the normal single-attempt path) even if admin messages are pending', async () => {
    const supa = mockSupabase({ pending: [{ id: 'm1', content: 'do this' }] });
    const note = await drainPendingAdminMessages(supa, RUN, 1);
    expect(note).toBe('');
    expect(supa.__updates).toHaveLength(0);
  });

  it('no-ops when attempt is undefined/0', async () => {
    const supa = mockSupabase({ pending: [{ id: 'm1', content: 'do this' }] });
    expect(await drainPendingAdminMessages(supa, RUN, undefined)).toBe('');
    expect(await drainPendingAdminMessages(supa, RUN, 0)).toBe('');
    expect(supa.__updates).toHaveLength(0);
  });

  it('returns "" and updates nothing when attempt > 1 but no messages are pending', async () => {
    const supa = mockSupabase({ pending: [] });
    const note = await drainPendingAdminMessages(supa, RUN, 2);
    expect(note).toBe('');
    expect(supa.__updates).toHaveLength(0);
  });

  it('drains pending admin messages and marks them delivered when attempt > 1', async () => {
    const supa = mockSupabase({ pending: [{ id: 'm1', content: 'focus on the auth bug' }, { id: 'm2', content: 'also check tests' }] });
    const note = await drainPendingAdminMessages(supa, RUN, 2);
    expect(note).toContain('focus on the auth bug');
    expect(note).toContain('also check tests');
    expect(note).toContain('ADMIN NOTE');
    expect(supa.__updates).toHaveLength(1);
    expect(supa.__updates[0]).toMatchObject({ table: 'se_messages' });
    expect(supa.__updates[0].row).toHaveProperty('delivered_at');
    expect(supa.__updates[0].row.delivered_at).not.toBeNull();
  });

  it('is best-effort: returns "" instead of throwing when the query fails', async () => {
    const supa = {
      from() {
        return {
          select() { return this; }, eq() { return this; }, is() { return this; }, order() { return this; },
          then() { throw new Error('db down'); },
        };
      },
    };
    const note = await drainPendingAdminMessages(supa, RUN, 2);
    expect(note).toBe('');
  });
});

describe('recomputeRunCost', () => {
  it('sums se_phases.cost_usd for the run and writes the rounded total to se_runs.cost_usd', async () => {
    const supa = mockSupabase({ phases: [{ cost_usd: 1.23456 }, { cost_usd: 2.0 }, { cost_usd: null }] });
    await recomputeRunCost(supa, RUN);
    expect(supa.__updates).toHaveLength(1);
    expect(supa.__updates[0]).toMatchObject({ table: 'se_runs', row: { cost_usd: 3.2346 } });
  });

  it('writes 0 when the run has no phase rows yet', async () => {
    const supa = mockSupabase({ phases: [] });
    await recomputeRunCost(supa, RUN);
    expect(supa.__updates[0].row.cost_usd).toBe(0);
  });
});
