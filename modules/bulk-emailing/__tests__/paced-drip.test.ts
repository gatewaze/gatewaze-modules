import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runDripTick, resetSuppressionState, type SendEngineBinding, type SendContext, type Recipient } from '../worker/send-engine/engine';

type Row = Record<string, any>;

/**
 * An in-memory PostgREST stand-in covering what runDripTick uses: filters
 * (eq / in / lt / gt), head counts, single / maybeSingle, insert-select,
 * update, upsert, and the RPCs the engine calls.
 */
function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0;
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let head = false;
    let patch: Row | null = null;
    let inserted: Row[] | null = null;
    let limit = Infinity;
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r))).slice(0, limit);
    const result = () => {
      if (inserted) return { data: inserted, error: null };
      if (patch) { for (const r of rows()) Object.assign(r, patch); return { data: null, error: null }; }
      if (head) return { count: rows().length, error: null };
      return { data: rows().map((r) => ({ ...r })), error: null };
    };
    const q: any = {
      select: (_c?: string, opts?: { head?: boolean }) => { head = !!opts?.head; return q; },
      update: (p: Row) => { patch = p; writes.push({ table, op: 'update', payload: p }); return q; },
      insert: (r: Row) => { const row = { id: `${table}-${++seq}`, ...r }; tables[table].push(row); inserted = [row]; writes.push({ table, op: 'insert', payload: r }); return q; },
      upsert: (rs: Row[]) => { tables[table].push(...rs); writes.push({ table, op: 'upsert', payload: rs }); return Promise.resolve({ error: null }); },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      lt: (k: string, v: string) => { filters.push((r) => r[k] < v); return q; },
      gt: (k: string, v: string) => { filters.push((r) => r[k] > v); return q; },
      limit: (n: number) => { limit = n; return q; },
      single: () => { const r = result() as { data: Row[] | null }; return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: null }); },
      maybeSingle: () => q.single(),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
    };
    return q;
  };
  const rpc = (fn: string, args: Row) => {
    if (fn === 'claim') {
      const live = new Set(tables.sends.filter((s) => s.status === 'sending').map((s) => s.id));
      const due = tables.recips.filter((r) => r.status === 'pending' && live.has(r.send_id)).slice(0, args.p_limit);
      for (const r of due) { r.status = 'sending'; r.attempts = (r.attempts ?? 0) + 1; }
      return Promise.resolve({ data: due.map((r) => ({ ...r })), error: null });
    }
    if (fn === 'claim_drip_quota') return Promise.resolve({ data: args.p_request, error: null });
    if (fn === 'compliance_suppressed_emails') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: 0, error: null });
  };
  return { supabase: { from, rpc }, writes };
}

const binding = (over: Partial<SendEngineBinding> = {}): SendEngineBinding => ({
  domain: 'broadcast', sendsTable: 'sends', recipientsTable: 'recips', batchesTable: 'batches',
  logSendIdColumn: 'broadcast_send_id', claimRpc: 'claim',
  buildSendContext: async (_d, sendId): Promise<SendContext> => ({
    sendId, brand: 'b', channel: 'slack', subject: 's', html: '', bodyText: 'Hi', fromEmail: '', fromName: '', replyTo: null,
    channelAuth: { token: 'xoxb' },
  }),
  buildSubstitutions: async () => ({}),
  ...over,
});

const recips = (n: number, over: Row = {}) => Array.from({ length: n }, (_, i) => ({
  id: `r${i}`, send_id: 's1', person_id: `p${i}`, email: `p${i}@x.io`, slack_user_id: `U00${i}AA`, timezone: null, status: 'pending', attempts: 0, ...over,
}));

function slackReplies(post: () => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const posted: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const p = Object.fromEntries(new URLSearchParams(String(init.body)));
    if (url.endsWith('conversations.open')) return new Response(JSON.stringify({ ok: true, channel: { id: `D-${p.users}` } }));
    posted.push(p.channel);
    const r = post();
    return new Response(JSON.stringify(r.body ?? { ok: true, ts: '1.1' }), { status: r.status ?? 200, headers: r.headers });
  });
  return posted;
}

const config = (over: Row = {}) => ({
  claimBatch: 10, batchSize: 1000, budgetMs: 10_000, dailyCap: 1e9, rampPercent: 100, replica: 't', ...over,
});
const logger = { info() {}, warn() {}, error() {} };

describe('runDripTick with a paced Slack channel', () => {
  beforeEach(() => { resetSuppressionState(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('sends one message per call, records no email_send_log rows, and marks each recipient sent', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack', total_recipients: 3 }], recips: recips(3) };
    const posted = slackReplies(() => ({}));
    const { supabase, writes } = fakeDb(tables);
    const out = await runDripTick({ supabase, logger, config: config({ minIntervalMs: 5 }) }, binding());
    expect(out).toMatchObject({ claimed: 3, sent: 3, failed: 0 });
    expect(posted).toHaveLength(3);
    expect(tables.recips.every((r) => r.status === 'sent')).toBe(true);
    expect(tables.batches).toHaveLength(3);
    expect(tables.batches.every((b) => b.status === 'accepted' && /^D-U00\dAA:1\.1$/.test(b.provider_batch_id))).toBe(true);
    expect(writes.some((w) => w.table === 'email_send_log')).toBe(false);
    expect(tables.sends[0].status).toBe('sent');
  });

  it('waits minIntervalMs between messages', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack' }], recips: recips(3) };
    const times: number[] = [];
    slackReplies(() => { times.push(Date.now()); return {}; });
    const { supabase } = fakeDb(tables);
    await runDripTick({ supabase, logger, config: config({ minIntervalMs: 60 }) }, binding());
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(55);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(55);
  });

  it('stops before overrunning the budget and puts the unsent rows back to pending', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack' }], recips: recips(5) };
    const posted = slackReplies(() => ({}));
    const { supabase } = fakeDb(tables);
    // 120ms budget, 50ms apart: posts start at about 0, 50 and 100ms; the
    // fourth would start at 150ms, past the budget.
    const out = await runDripTick({ supabase, logger, config: config({ minIntervalMs: 50, budgetMs: 120 }) }, binding());
    expect(posted).toHaveLength(3);
    expect(out.sent).toBe(posted.length);
    const statuses = tables.recips.map((r) => r.status);
    expect(statuses.filter((s) => s === 'sent')).toHaveLength(posted.length);
    expect(statuses.filter((s) => s === 'pending')).toHaveLength(5 - posted.length);
    expect(statuses).not.toContain('sending');
    expect(tables.sends[0].status).toBe('sending');
  });

  it('pauses the send and releases everything when the token is refused', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack', metadata: {} }], recips: recips(4) };
    const posted = slackReplies(() => ({ body: { ok: false, error: 'token_revoked' } }));
    const halted: string[] = [];
    const { supabase } = fakeDb(tables);
    const out = await runDripTick({ supabase, logger, config: config({ minIntervalMs: 1 }) }, binding({
      onSendHalted: async (_d, sendId, reason) => { halted.push(`${sendId}: ${reason}`); },
    }));
    expect(posted).toHaveLength(1);
    expect(out).toMatchObject({ sent: 0, failed: 0 });
    expect(tables.sends[0].status).toBe('paused');
    expect(tables.recips.every((r) => r.status === 'pending')).toBe(true);
    expect(tables.recips[0].last_error).toMatch(/token_revoked/);
    expect(halted).toHaveLength(1);
    expect(halted[0]).toMatch(/^s1: .*token_revoked/);
  });

  it('marks a permanent failure failed with the reason, and carries on', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack' }], recips: recips(2) };
    let n = 0;
    slackReplies(() => (n++ === 0 ? { body: { ok: false, error: 'user_disabled' } } : {}));
    const { supabase } = fakeDb(tables);
    const out = await runDripTick({ supabase, logger, config: config({ minIntervalMs: 1 }) }, binding());
    expect(out).toMatchObject({ sent: 1, failed: 1 });
    expect(tables.recips[0]).toMatchObject({ status: 'failed' });
    expect(tables.recips[0].last_error).toMatch(/user_disabled/);
    expect(tables.recips[1].status).toBe('sent');
  });

  it('backs off for the rest of the tick when rate limited', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack' }], recips: recips(3) };
    const posted = slackReplies(() => ({ status: 429, headers: { 'retry-after': '30' } }));
    const { supabase } = fakeDb(tables);
    const out = await runDripTick({ supabase, logger, config: config({ minIntervalMs: 1 }) }, binding());
    expect(posted).toHaveLength(1);
    expect(out).toMatchObject({ claimed: 3, sent: 0, failed: 0 });
    expect(tables.recips.every((r) => r.status === 'pending')).toBe(true);
  });

  it('gives up on a retryable failure after maxAttempts claims', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack' }], recips: recips(1, { attempts: 4 }) };
    slackReplies(() => ({ body: { ok: false, error: 'internal_error' } }));
    const { supabase } = fakeDb(tables);
    const out = await runDripTick({ supabase, logger, config: config({ minIntervalMs: 1, maxAttempts: 5 }) }, binding());
    expect(out.failed).toBe(1);
    expect(tables.recips[0]).toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('fails a recipient with no Slack user ID instead of marking it sent', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack' }], recips: recips(1, { slack_user_id: null }) };
    const posted = slackReplies(() => ({}));
    const { supabase } = fakeDb(tables);
    const out = await runDripTick({ supabase, logger, config: config({ minIntervalMs: 1 }) }, binding());
    expect(posted).toHaveLength(0);
    expect(out.failed).toBe(1);
    expect(tables.recips[0].status).toBe('failed');
  });
});

describe('runDripTick paced: admin actions and retries', () => {
  beforeEach(() => { resetSuppressionState(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('stops between messages when the send is paused mid-tick, without spending attempts', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack' }], recips: recips(4) };
    const posted = slackReplies(() => { tables.sends[0].status = 'paused'; return {}; });
    const { supabase } = fakeDb(tables);
    await runDripTick({ supabase, logger, config: config({ minIntervalMs: 1, maxAttempts: 5 }) }, binding());
    expect(posted).toHaveLength(1);
    expect(tables.recips[0]).toMatchObject({ status: 'sent', attempts: 1 });
    expect(tables.recips.slice(1).map((r) => [r.status, r.attempts])).toEqual([['pending', 0], ['pending', 0], ['pending', 0]]);
    expect(tables.sends[0].status).toBe('paused');
  });

  it('never relabels a send cancelled during the tick as sent', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack', total_recipients: 0 }], recips: recips(3) };
    // Another tick's cancel sweep lands while the first message is going out.
    slackReplies(() => {
      tables.sends[0].status = 'cancelled';
      for (const r of tables.recips) if (r.id !== 'r0') r.status = 'skipped';
      return {};
    });
    const { supabase } = fakeDb(tables);
    await runDripTick({ supabase, logger, config: config({ minIntervalMs: 1 }) }, binding());
    expect(tables.sends[0].status).toBe('cancelled');
    // The sweep's 'skipped' stands; the one message that went out is 'sent'.
    expect(tables.recips.map((r) => r.status)).toEqual(['sent', 'skipped', 'skipped']);
  });

  it('does not overwrite a cancel with a pause when the token is refused', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'slack', metadata: {} }], recips: recips(2) };
    slackReplies(() => { tables.sends[0].status = 'cancelling'; return { body: { ok: false, error: 'token_revoked' } }; });
    const { supabase } = fakeDb(tables);
    await runDripTick({ supabase, logger, config: config({ minIntervalMs: 1 }) }, binding());
    expect(['cancelling', 'cancelled']).toContain(tables.sends[0].status);
  });

  it('backs off across every send in the claim, and only the tried row spends an attempt', async () => {
    const tables: Record<string, Row[]> = {
      sends: [{ id: 's1', status: 'sending', channel: 'slack' }, { id: 's2', status: 'sending', channel: 'slack' }],
      recips: [...recips(2), ...recips(2).map((r) => ({ ...r, id: `${r.id}b`, send_id: 's2' }))],
    };
    const posted = slackReplies(() => ({ status: 429, headers: { 'retry-after': '20' } }));
    const { supabase } = fakeDb(tables);
    await runDripTick({ supabase, logger, config: config({ minIntervalMs: 1, maxAttempts: 5 }) }, binding());
    expect(posted).toHaveLength(1);
    expect(tables.recips.every((r) => r.status === 'pending')).toBe(true);
    expect(tables.recips.map((r) => r.attempts)).toEqual([1, 0, 0, 0]);
  });
});

describe('email reputation gate still applies', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('pauses an email send with a high bounce rate before calling the provider', async () => {
    const recent = new Date().toISOString();
    const tables: Record<string, Row[]> = {
      sends: [{ id: 's1', status: 'sending', channel: 'email' }],
      recips: recips(2),
      email_send_log: Array.from({ length: 60 }, (_, i) => ({ id: `l${i}`, broadcast_send_id: 's1', status: 'bounced', sent_at: recent })),
    };
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return new Response('', { status: 202 }); });
    const { supabase } = fakeDb(tables);
    const emailBinding = binding({
      buildSendContext: async (_d, sendId) => ({ sendId, brand: 'b', channel: 'email', subject: 's', html: '<p>x</p>', fromEmail: 'a@b.c', fromName: 'A', replyTo: null }),
    });
    await runDripTick({ supabase, logger, config: config() }, emailBinding);
    expect(calls).toHaveLength(0);
    expect(tables.sends[0].status).toBe('paused');
    expect(tables.recips.every((r) => r.status === 'pending')).toBe(true);
  });
});

describe('runDripTick with email is unchanged by pacing', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends a whole claim in one provider call and writes the send log', async () => {
    const tables: Record<string, Row[]> = { sends: [{ id: 's1', status: 'sending', channel: 'email', total_recipients: 3 }], recips: recips(3) };
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return new Response('', { status: 202, headers: { 'x-message-id': 'm1' } }); });
    process.env.SENDGRID_API_KEY ??= 'test';
    const { supabase, writes } = fakeDb(tables);
    const emailBinding = binding({
      buildSendContext: async (_d, sendId) => ({ sendId, brand: 'b', channel: 'email', subject: 's', html: '<p>x</p>', fromEmail: 'a@b.c', fromName: 'A', replyTo: null }),
    });
    const out = await runDripTick({ supabase, logger, config: config() }, emailBinding);
    expect(out).toMatchObject({ claimed: 3, sent: 3 });
    expect(calls).toHaveLength(1);
    expect(writes.filter((w) => w.table === 'email_send_log')).toHaveLength(1);
  });
});

export type { Recipient };
