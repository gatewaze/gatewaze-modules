import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The research send gate at dispatch: checked BEFORE fan-out, and a refusal
 * leaves the send 'scheduled' with the reason in last_error (never 'failed').
 */

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown[]]> };
const state: {
  due: Array<Record<string, unknown>>;
  gate: { allowed: boolean; reason_code: string; block_id: string | null };
  flipError: string | null;
  rpcs: Array<[string, unknown]>;
  calls: Call[];
} = { due: [], gate: { allowed: true, reason_code: 'OK', block_id: null }, flipError: null, rpcs: [], calls: [] };

function query(table: string) {
  const call: Call = { table, op: 'select', filters: [] };
  state.calls.push(call);
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'lte', 'order', 'limit', 'not', 'in']) {
    q[m] = (...args: unknown[]) => { call.filters.push([m, args]); return q; };
  }
  q.update = (payload: unknown) => { call.op = 'update'; call.payload = payload; return q; };
  q.then = (resolve: (v: unknown) => unknown) => {
    if (call.op === 'update') {
      const p = call.payload as { status?: string };
      return resolve({ data: null, error: p.status === 'sending' && state.flipError ? { message: state.flipError } : null });
    }
    if (table === 'newsletter_sends') return resolve({ data: state.due, error: null });
    return resolve({ data: null, error: null, count: 3 });
  };
  return q;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => query(t),
    rpc: async (fn: string, args: unknown) => {
      state.rpcs.push([fn, args]);
      if (fn === 'newsletters_send_gate') return { data: [state.gate], error: null };
      if (fn === 'fanout_newsletter_send_recipients_batch') return { data: [{ last_email: null, remaining: false }], error: null };
      return { data: null, error: null };
    },
  }),
}));

const { default: handleDispatchScheduled } = await import('../dispatch-scheduled.js');

// The drip tick after dispatch makes its own rpc calls; only these two matter here.
const dispatchRpcs = () => state.rpcs.map(([fn]) => fn).filter((fn) => fn === 'newsletters_send_gate' || fn === 'fanout_newsletter_send_recipients_batch');
const updatesTo = (table: string) => state.calls.filter((c) => c.table === table && c.op === 'update');

beforeEach(() => {
  state.due = [{ id: 's1', edition_id: 'e1', last_error: null }];
  state.gate = { allowed: true, reason_code: 'OK', block_id: null };
  state.flipError = null;
  state.rpcs = [];
  state.calls = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('dispatch-scheduled research gate', () => {
  it('a gate refusal holds the send: no fan-out, stays scheduled, reason recorded', async () => {
    state.gate = { allowed: false, reason_code: 'RESEARCH_IN_PROGRESS', block_id: 'b1' };
    const r = await handleDispatchScheduled({ data: { kind: 'x' } } as never);
    expect(dispatchRpcs()).toEqual(['newsletters_send_gate']);
    const ups = updatesTo('newsletter_sends');
    expect(ups).toHaveLength(1);
    expect(ups[0].payload).toMatchObject({ last_error: 'SEND_GATE:RESEARCH_IN_PROGRESS:b1' });
    expect((ups[0].payload as { status?: string }).status).toBeUndefined();
    expect(ups[0].filters).toContainEqual(['eq', ['status', 'scheduled']]);
    expect(r.processed).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('an unchanged hold reason is not rewritten every tick', async () => {
    state.gate = { allowed: false, reason_code: 'NO_RESEARCH_RUN', block_id: 'b1' };
    state.due = [{ id: 's1', edition_id: 'e1', last_error: 'SEND_GATE:NO_RESEARCH_RUN:b1' }];
    await handleDispatchScheduled({ data: { kind: 'x' } } as never);
    expect(updatesTo('newsletter_sends')).toHaveLength(0);
  });

  it('gate allowed: fans out, flips to sending and clears last_error', async () => {
    const r = await handleDispatchScheduled({ data: { kind: 'x' } } as never);
    expect(dispatchRpcs()).toEqual(['newsletters_send_gate', 'fanout_newsletter_send_recipients_batch']);
    expect(updatesTo('newsletter_sends')[0].payload).toMatchObject({ status: 'sending', last_error: null });
    expect(r.processed).toBe(1);
  });

  it('the trigger refusing the flip (race) also holds rather than failing the send', async () => {
    state.flipError = 'SEND_GATE:RESEARCH_IN_PROGRESS:b2';
    const r = await handleDispatchScheduled({ data: { kind: 'x' } } as never);
    const ups = updatesTo('newsletter_sends');
    expect(ups.map((u) => (u.payload as { status?: string }).status)).toEqual(['sending', undefined]);
    expect(ups[1].payload).toMatchObject({ last_error: 'SEND_GATE:RESEARCH_IN_PROGRESS:b2' });
    expect(r.errors).toEqual([]);
  });
});
