// @ts-nocheck — vitest harness; the lib/workers modules are @ts-nocheck'd already.
//
// Exercises the recovery reconciler's job-state check (issue #50): before re-driving an orphaned
// run's phase, it must look up the deterministic-id BullMQ job (see lib/enqueue.ts's phaseJobId) and
// tell a genuinely live job apart from an orphaned Redis hash, instead of blindly re-enqueuing (which
// silently no-ops on a live job's id, masking the fact that nothing was actually recovered).
import { describe, it, expect, vi } from 'vitest';
import recover from '../recover.js';

const RUN = { id: 'run-1', site_id: 'site-1', current_phase: 'implement', updated_at: '2020-01-01T00:00:00.000Z', engineer_name: 'claude' };

function mockSupabase({ candidates = [], lastEventCreatedAt = null } = {}) {
  const inserts: any[] = [];
  const updates: any[] = [];
  const from = (table: string) => {
    const b: any = {
      select() { return b; },
      insert(row: unknown) { inserts.push({ table, row }); return Promise.resolve({ data: null, error: null }); },
      update(row: unknown) { updates.push({ table, row }); return b; },
      eq() { return b; }, is() { return b; }, in() { return b; }, lt() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() {
        return Promise.resolve({ data: lastEventCreatedAt ? { created_at: lastEventCreatedAt } : null, error: null });
      },
      then(onF: any, onR: any) {
        if (table === 'se_runs') return Promise.resolve({ data: candidates, error: null }).then(onF, onR);
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return b;
  };
  return { from, __inserts: inserts, __updates: updates };
}

function mockCtx({ existingJob = undefined } = {}) {
  const enqueueJob = vi.fn(async () => ({ id: 'new-job-1' }));
  const getJob = vi.fn(async () => existingJob);
  const getQueue = vi.fn(() => ({ getJob }));
  return { enqueueJob, getQueue, getJob };
}

describe('recover', () => {
  it('removes an orphaned job (terminal state) and re-drives the phase', async () => {
    const supabase = mockSupabase({ candidates: [RUN] });
    const remove = vi.fn(async () => {});
    const existingJob = { getState: vi.fn(async () => 'failed'), remove };
    const ctx = mockCtx({ existingJob });
    ctx.supabase = supabase;

    const result = await recover(null, ctx);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(ctx.enqueueJob).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ recovered: 1 });

    const kinds = supabase.__inserts.map((i) => i.row.payload.recover);
    expect(kinds).toEqual(['removed_orphaned_job', 're_drove']);
  });

  it('skips a run whose job is genuinely still active', async () => {
    const supabase = mockSupabase({ candidates: [RUN] });
    const remove = vi.fn(async () => {});
    const existingJob = { getState: vi.fn(async () => 'active'), remove };
    const ctx = mockCtx({ existingJob });
    ctx.supabase = supabase;

    const result = await recover(null, ctx);

    expect(remove).not.toHaveBeenCalled();
    expect(ctx.enqueueJob).not.toHaveBeenCalled();
    expect(result).toEqual({ recovered: 0 });
    expect(supabase.__inserts).toHaveLength(0);
  });

  it('falls back to unconditional re-drive when no existing job is found', async () => {
    const supabase = mockSupabase({ candidates: [RUN] });
    const ctx = mockCtx({ existingJob: undefined });
    ctx.supabase = supabase;

    const result = await recover(null, ctx);

    expect(ctx.getJob).toHaveBeenCalledTimes(1);
    expect(ctx.enqueueJob).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ recovered: 1 });

    const kinds = supabase.__inserts.map((i) => i.row.payload.recover);
    expect(kinds).toEqual(['re_drove']);
  });

  it('skips a healthy run (recent event) before making any Redis call', async () => {
    const recentIso = new Date().toISOString();
    const supabase = mockSupabase({ candidates: [RUN], lastEventCreatedAt: recentIso });
    const ctx = mockCtx();
    ctx.supabase = supabase;

    const result = await recover(null, ctx);

    expect(ctx.getQueue).not.toHaveBeenCalled();
    expect(ctx.enqueueJob).not.toHaveBeenCalled();
    expect(result).toEqual({ recovered: 0 });
  });
});
