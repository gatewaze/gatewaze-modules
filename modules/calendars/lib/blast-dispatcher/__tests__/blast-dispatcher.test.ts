import { describe, expect, it, vi } from 'vitest';
import { dispatchScheduledBlasts, type ChannelDispatcher, type DispatcherSupabaseClient } from '../index.js';

// ---------------------------------------------------------------------------
// Fake Supabase that records calls + lets tests control the data scripts
// ---------------------------------------------------------------------------

interface RecordedCall {
  table: string;
  op: 'select' | 'update';
  values?: Record<string, unknown>;
  filters: Array<{ col: string; val: unknown; cmp?: 'eq' | 'lte' }>;
  ordered?: boolean;
  limit?: number;
}

interface FakeScript {
  /** Rows returned by the initial `SELECT … WHERE status='scheduled'`. */
  due: Array<{ id: string; calendar_id: string; channel: string }> | { error: string };
  /** For each blast id, what the CAS update returns (data length 0 = lost
   *  the race; data length 1 = claimed). Defaults to claimed. */
  cas?: Record<string, { data: unknown[]; error: { message: string } | null }>;
}

function makeFakeSupabase(script: FakeScript): { supabase: DispatcherSupabaseClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const supabase: DispatcherSupabaseClient = {
    from(table: string) {
      const call: RecordedCall = { table, op: 'select', filters: [] };
      calls.push(call);

      const q: any = {
        select(_cols: string) {
          // For UPDATE chains, .select() is the terminator that returns
          // { data: rows, error } — used by the CAS guard.
          if (call.op === 'update') {
            const idFilter = call.filters.find((f) => f.col === 'id');
            const statusFilter = call.filters.find((f) => f.col === 'status');
            // CAS guard: id + status='scheduled' → consult cas script
            if (idFilter && statusFilter?.val === 'scheduled') {
              const id = idFilter.val as string;
              return Promise.resolve(script.cas?.[id] ?? { data: [{ id }], error: null });
            }
            return Promise.resolve({ data: null, error: null });
          }
          // For SELECT chains, .select() is mid-chain — keep the builder.
          return q;
        },
        update(values: Record<string, unknown>) {
          call.op = 'update';
          call.values = values;
          return q;
        },
        eq(col: string, val: unknown) {
          call.filters.push({ col, val, cmp: 'eq' });
          // For UPDATE chains without a trailing .select(), .eq() is the
          // terminator (e.g. "mark failed"). Detect by checking whether
          // we've satisfied the typical "update where id" shape.
          // We resolve via .then() (PromiseLike) so callers can await.
          return q;
        },
        lte(col: string, val: unknown) {
          call.filters.push({ col, val, cmp: 'lte' });
          return q;
        },
        order(_col: string, _opts: unknown) {
          call.ordered = true;
          return q;
        },
        limit(n: number) {
          call.limit = n;
          if ('error' in script.due) {
            return Promise.resolve({ data: null, error: { message: script.due.error } });
          }
          return Promise.resolve({ data: script.due, error: null });
        },
        // Generic awaitable terminator for trailing updates that don't go
        // through the CAS path (e.g. the "mark failed" updates which end
        // at `.eq('id', blast.id)` without a chained `.select()`).
        then(onfulfilled: (v: { data: null; error: null }) => unknown) {
          return Promise.resolve(onfulfilled({ data: null, error: null }));
        },
      };
      return q;
    },
  };

  return { supabase, calls };
}

function makeChannel(behaviour: 'ok' | 'fail' | 'throw' = 'ok'): ChannelDispatcher & { calls: number } {
  const dispatcher: any = {
    calls: 0,
    async dispatch(_args: { blastId: string; calendarId: string }) {
      dispatcher.calls++;
      if (behaviour === 'fail') return { ok: false, reason: 'simulated_failure' };
      if (behaviour === 'throw') throw new Error('boom');
      return { ok: true };
    },
  };
  return dispatcher;
}

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatchScheduledBlasts', () => {
  it('returns zero counts when no blasts are due', async () => {
    const { supabase } = makeFakeSupabase({ due: [] });
    const result = await dispatchScheduledBlasts({ supabase, channels: { email: makeChannel() } });
    expect(result).toEqual({ picked: 0, dispatched: 0, failed: 0, perBlast: [] });
  });

  it('logs + returns empty when select errors out', async () => {
    const { supabase } = makeFakeSupabase({ due: { error: 'connection refused' } });
    const result = await dispatchScheduledBlasts({ supabase, channels: { email: makeChannel() }, logger: noopLogger });
    expect(result.picked).toBe(0);
    expect(noopLogger.error).toHaveBeenCalledWith(
      'blast-dispatcher: failed to load due blasts',
      expect.objectContaining({ error: 'connection refused' }),
    );
  });

  it('dispatches an email blast end-to-end (CAS claim → channel.dispatch)', async () => {
    const { supabase, calls } = makeFakeSupabase({
      due: [{ id: 'blast-1', calendar_id: 'cal-1', channel: 'email' }],
    });
    const email = makeChannel('ok');
    const result = await dispatchScheduledBlasts({ supabase, channels: { email } });
    expect(result).toEqual({
      picked: 1,
      dispatched: 1,
      failed: 0,
      perBlast: [{ id: 'blast-1', status: 'dispatched' }],
    });
    expect(email.calls).toBe(1);
    // Verify the SELECT used the right shape
    const selectCall = calls.find((c) => c.op === 'select');
    expect(selectCall?.filters.some((f) => f.col === 'status' && f.val === 'scheduled')).toBe(true);
    expect(selectCall?.filters.some((f) => f.col === 'scheduled_at' && f.cmp === 'lte')).toBe(true);
  });

  it('skips blasts where the CAS lost the race (already claimed)', async () => {
    const { supabase } = makeFakeSupabase({
      due: [{ id: 'blast-1', calendar_id: 'cal-1', channel: 'email' }],
      cas: { 'blast-1': { data: [], error: null } }, // no rows changed = lost the race
    });
    const email = makeChannel();
    const result = await dispatchScheduledBlasts({ supabase, channels: { email }, logger: noopLogger });
    expect(result.picked).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
    expect(email.calls).toBe(0);
    expect(noopLogger.info).toHaveBeenCalledWith(
      'blast-dispatcher: skipped (already claimed)',
      expect.objectContaining({ blastId: 'blast-1' }),
    );
  });

  it('marks blast failed when channel module is missing', async () => {
    const { supabase } = makeFakeSupabase({
      due: [{ id: 'blast-sms', calendar_id: 'cal-1', channel: 'sms' }],
    });
    // No 'sms' dispatcher registered
    const result = await dispatchScheduledBlasts({ supabase, channels: { email: makeChannel() }, logger: noopLogger });
    expect(result.failed).toBe(1);
    expect(result.perBlast[0]).toEqual({
      id: 'blast-sms',
      status: 'failed',
      reason: 'channel_module_not_installed',
    });
  });

  it('marks blast failed when the channel returns ok=false', async () => {
    const { supabase } = makeFakeSupabase({
      due: [{ id: 'blast-1', calendar_id: 'cal-1', channel: 'email' }],
    });
    const result = await dispatchScheduledBlasts({
      supabase,
      channels: { email: makeChannel('fail') },
      logger: noopLogger,
    });
    expect(result.failed).toBe(1);
    expect(result.perBlast[0]?.reason).toBe('simulated_failure');
  });

  it('marks blast failed when the channel throws (does not crash the tick)', async () => {
    const { supabase } = makeFakeSupabase({
      due: [
        { id: 'blast-1', calendar_id: 'cal-1', channel: 'email' },
        { id: 'blast-2', calendar_id: 'cal-1', channel: 'email' },
      ],
    });
    let callCount = 0;
    const flaky: ChannelDispatcher = {
      async dispatch() {
        callCount++;
        if (callCount === 1) throw new Error('boom on first');
        return { ok: true };
      },
    };
    const result = await dispatchScheduledBlasts({ supabase, channels: { email: flaky }, logger: noopLogger });
    // First failed, second dispatched — single bad blast doesn't block the batch
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.perBlast[0]).toMatchObject({ status: 'failed', reason: 'boom on first' });
    expect(result.perBlast[1]).toMatchObject({ status: 'dispatched' });
  });

  it('honours batchSize limit on the SELECT', async () => {
    const { supabase, calls } = makeFakeSupabase({ due: [] });
    await dispatchScheduledBlasts({ supabase, channels: { email: makeChannel() }, batchSize: 7 });
    const selectCall = calls.find((c) => c.op === 'select');
    expect(selectCall?.limit).toBe(7);
  });

  it('uses the injected `now` for the scheduled_at <= cutoff', async () => {
    const fixedNow = new Date('2026-04-25T12:00:00Z');
    const { supabase, calls } = makeFakeSupabase({ due: [] });
    await dispatchScheduledBlasts({ supabase, channels: {}, now: () => fixedNow });
    const selectCall = calls.find((c) => c.op === 'select');
    const cutoff = selectCall?.filters.find((f) => f.col === 'scheduled_at')?.val;
    expect(cutoff).toBe(fixedNow.toISOString());
  });
});
