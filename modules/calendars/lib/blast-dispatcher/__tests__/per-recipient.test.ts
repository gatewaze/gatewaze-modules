import { describe, expect, it, vi } from 'vitest';
import {
  dispatchPerRecipient,
  type AudienceRecipient,
  type PerRecipientSupabaseClient,
  type SingleSendFn,
} from '../per-recipient.js';

// ---------------------------------------------------------------------------
// Fake Supabase scriptable per call
// ---------------------------------------------------------------------------

interface RecordedUpdate {
  id: string;
  values: Record<string, unknown>;
}

interface FakeScript {
  blast?: { body_template?: string | null; audience_filter?: unknown } | null;
  blastError?: string;
  audience: AudienceRecipient[] | { error: string };
}

function makeFakeSupabase(script: FakeScript): {
  supabase: PerRecipientSupabaseClient;
  updates: RecordedUpdate[];
} {
  const updates: RecordedUpdate[] = [];

  const supabase: PerRecipientSupabaseClient = {
    from(_table: string) {
      const ctx: { op?: 'select' | 'update'; values?: Record<string, unknown>; idFilter?: string } = {};
      const q: any = {
        select(_cols: string) {
          ctx.op = 'select';
          return q;
        },
        update(values: Record<string, unknown>) {
          ctx.op = 'update';
          ctx.values = values;
          return q;
        },
        eq(col: string, val: unknown) {
          if (col === 'id') ctx.idFilter = val as string;
          if (ctx.op === 'update' && col === 'id') {
            updates.push({ id: val as string, values: ctx.values ?? {} });
            return Promise.resolve({ data: null, error: null });
          }
          return q;
        },
        single() {
          if (script.blastError) {
            return Promise.resolve({ data: null, error: { message: script.blastError } });
          }
          return Promise.resolve({ data: script.blast ?? null, error: null });
        },
        then(onfulfilled: (v: { data: null; error: null }) => unknown) {
          return Promise.resolve(onfulfilled({ data: null, error: null }));
        },
      };
      return q;
    },
    async rpc(_fn, _args) {
      if ('error' in script.audience) {
        return { data: null, error: { message: script.audience.error } };
      }
      return { data: script.audience, error: null };
    },
  };

  return { supabase, updates };
}

function makeSendFn(behaviour: 'ok' | 'fail' | 'mixed' | 'throw' = 'ok'): SingleSendFn & { calls: number } {
  let callCount = 0;
  const fn: any = {
    get calls() { return callCount; },
    async send(_args: { to: string; body: string; metadata: unknown }) {
      callCount++;
      if (behaviour === 'fail') return { ok: false, reason: 'simulated_failure' };
      if (behaviour === 'throw') throw new Error('boom');
      // 'mixed' = first ok, second fails, third ok, etc.
      if (behaviour === 'mixed') {
        return callCount % 2 === 0 ? { ok: false, reason: 'mixed_failure' } : { ok: true };
      }
      return { ok: true };
    },
  };
  return fn;
}

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// No-op sleep so the tests don't actually wait between sends
const fastSleep = () => Promise.resolve();

const r = (member_id: string, phone: string | null, email: string | null = null): AudienceRecipient => ({
  member_id,
  phone,
  email,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatchPerRecipient', () => {
  it('returns ok=false when blast lookup fails', async () => {
    const { supabase } = makeFakeSupabase({
      blastError: 'connection refused',
      audience: [],
    });
    const result = await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'sms',
      send: makeSendFn(),
      sleep: fastSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('connection refused');
  });

  it('returns ok=false when blast not found', async () => {
    const { supabase } = makeFakeSupabase({
      blast: null,
      audience: [],
    });
    const result = await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'sms',
      send: makeSendFn(),
      sleep: fastSleep,
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when audience resolver fails', async () => {
    const { supabase } = makeFakeSupabase({
      blast: { body_template: 'hi', audience_filter: {} },
      audience: { error: 'rpc broken' },
    });
    const result = await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'sms',
      send: makeSendFn(),
      sleep: fastSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('audience resolve failed');
  });

  it('returns ok=true for empty audience and marks blast sent', async () => {
    const { supabase, updates } = makeFakeSupabase({
      blast: { body_template: 'hi', audience_filter: {} },
      audience: [],
    });
    const result = await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'sms',
      send: makeSendFn(),
      sleep: fastSleep,
    });
    expect(result).toEqual({ ok: true, sent: 0, failed: 0, total: 0 });
    // empty audience → no failures → sent (nothing to do)
    expect(updates.find((u) => u.id === 'b-1')?.values).toEqual({ status: 'sent' });
  });

  it('happy path: all recipients succeed, status=sent', async () => {
    const send = makeSendFn('ok');
    const { supabase, updates } = makeFakeSupabase({
      blast: { body_template: 'hi {{name}}', audience_filter: {} },
      audience: [r('m-1', '+15550001'), r('m-2', '+15550002'), r('m-3', '+15550003')],
    });
    const result = await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'sms',
      send,
      sleep: fastSleep,
    });
    expect(result).toEqual({ ok: true, sent: 3, failed: 0, total: 3 });
    expect(send.calls).toBe(3);
    expect(updates.find((u) => u.id === 'b-1')?.values).toEqual({ status: 'sent' });
  });

  it('skips recipients with no phone and counts as failed', async () => {
    const send = makeSendFn('ok');
    const { supabase, updates } = makeFakeSupabase({
      blast: { body_template: 'hi', audience_filter: {} },
      audience: [r('m-1', '+15550001'), r('m-2', null), r('m-3', '+15550003')],
    });
    const result = await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'sms',
      send,
      sleep: fastSleep,
      logger: noopLogger,
    });
    expect(result).toEqual({ ok: true, sent: 2, failed: 1, total: 3 });
    expect(send.calls).toBe(2);
    // partial success → 'sent' (the failed one is reflected in failed count)
    expect(updates.find((u) => u.id === 'b-1')?.values).toEqual({ status: 'sent' });
  });

  it('marks blast failed when all sends fail', async () => {
    const { supabase, updates } = makeFakeSupabase({
      blast: { body_template: 'hi', audience_filter: {} },
      audience: [r('m-1', '+15550001'), r('m-2', '+15550002')],
    });
    const result = await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'sms',
      send: makeSendFn('fail'),
      sleep: fastSleep,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(2);
    expect(updates.find((u) => u.id === 'b-1')?.values).toEqual({ status: 'failed' });
  });

  it('partial success: 1 of 2 sends → status=sent (success-skewed)', async () => {
    const { supabase, updates } = makeFakeSupabase({
      blast: { body_template: 'hi', audience_filter: {} },
      audience: [r('m-1', '+15550001'), r('m-2', '+15550002')],
    });
    const result = await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'sms',
      send: makeSendFn('mixed'),
      sleep: fastSleep,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(updates.find((u) => u.id === 'b-1')?.values).toEqual({ status: 'sent' });
  });

  it('passes the channel through to the audience RPC', async () => {
    const { supabase } = makeFakeSupabase({
      blast: { body_template: 'hi', audience_filter: { membership_status: ['active'] } },
      audience: [],
    });
    const rpcSpy = vi.spyOn(supabase, 'rpc');
    await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'whatsapp',
      send: makeSendFn(),
      sleep: fastSleep,
    });
    expect(rpcSpy).toHaveBeenCalledWith('resolve_calendar_audience', expect.objectContaining({
      p_calendar_id: 'cal-1',
      p_channel: 'whatsapp',
    }));
  });

  it('honours delayMs by calling the injected sleep between sends', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { supabase } = makeFakeSupabase({
      blast: { body_template: 'hi', audience_filter: {} },
      audience: [r('m-1', '+1'), r('m-2', '+2'), r('m-3', '+3')],
    });
    await dispatchPerRecipient('b-1', 'cal-1', {
      supabase,
      channel: 'sms',
      send: makeSendFn(),
      sleep,
      delayMs: 100,
    });
    // 3 sends → 3 sleep calls (one after each)
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('passes blast_id + calendar_id + member_id in send metadata', async () => {
    const sendSpy = vi.fn(async () => ({ ok: true as const }));
    const { supabase } = makeFakeSupabase({
      blast: { body_template: 'hi', audience_filter: {} },
      audience: [r('m-42', '+15551234')],
    });
    await dispatchPerRecipient('blast-7', 'cal-9', {
      supabase,
      channel: 'sms',
      send: { send: sendSpy },
      sleep: fastSleep,
    });
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      to: '+15551234',
      body: 'hi',
      metadata: { blast_id: 'blast-7', calendar_id: 'cal-9', member_id: 'm-42' },
    }));
  });
});
