import { describe, it, expect } from 'vitest';
import { classifySlackError, makeSlackChannelProvider, renderSlackText, MAX_SLACK_MESSAGE_CHARS } from '../worker/send-engine/channels/slack';
import type { BatchedMessage } from '../worker/send-engine/channels/types';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that answers each Slack method from a queue and records the calls. */
function fakeSlack(replies: Record<string, Reply[]>) {
  const calls: Array<{ method: string; params: Record<string, string>; auth: string | null }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const method = url.split('/').pop()!;
    calls.push({ method, params: Object.fromEntries(new URLSearchParams(String(init.body))), auth: (init.headers as Record<string, string>).Authorization ?? null });
    const r = (replies[method] ?? []).shift() ?? { body: { ok: false, error: 'unexpected_call' } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  };
  return { calls, provider: makeSlackChannelProvider(fetchImpl) };
}

const msg = (over: Partial<BatchedMessage> = {}): BatchedMessage => ({
  from: '', subject: '', bodyText: 'Hi {{first_name}}', auth: { token: 'xoxb-test' },
  personalizations: [{ to: 'U123ABC', substitutions: { '{{first_name}}': 'Sam' } }],
  ...over,
});

const opened = { body: { ok: true, channel: { id: 'D999' } } };

describe('slack channel provider', () => {
  it('opens the DM, posts the rendered text, and returns channel:ts', async () => {
    const { provider, calls } = fakeSlack({ 'conversations.open': [opened], 'chat.postMessage': [{ body: { ok: true, ts: '1700.01' } }] });
    const r = await provider.sendBatch(msg());
    expect(r).toEqual({ success: true, batchMessageId: 'D999:1700.01' });
    expect(calls.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage']);
    expect(calls[0].params.users).toBe('U123ABC');
    expect(calls[1].params).toMatchObject({ channel: 'D999', text: 'Hi Sam' });
    expect(calls[1].auth).toBe('Bearer xoxb-test');
  });

  it('pauses the send, without posting, when there is no token', async () => {
    const { provider, calls } = fakeSlack({});
    const r = await provider.sendBatch(msg({ auth: { token: '' } }));
    expect(r.success).toBe(false);
    expect(r.haltSend).toMatch(/No Slack token/);
    expect(calls).toHaveLength(0);
  });

  it('pauses the send when Slack refuses the token', async () => {
    const { provider } = fakeSlack({ 'conversations.open': [{ body: { ok: false, error: 'missing_scope' } }] });
    const r = await provider.sendBatch(msg());
    expect(r).toMatchObject({ success: false, retryable: true });
    expect(r.haltSend).toMatch(/missing_scope/);
  });

  it('fails only this recipient for a permanent error', async () => {
    const { provider } = fakeSlack({ 'conversations.open': [{ body: { ok: false, error: 'user_not_found' } }] });
    const r = await provider.sendBatch(msg());
    expect(r).toMatchObject({ success: false, retryable: false });
    expect(r.haltSend).toBeUndefined();
  });

  it('passes on Retry-After when rate limited', async () => {
    const { provider } = fakeSlack({ 'conversations.open': [opened], 'chat.postMessage': [{ status: 429, headers: { 'retry-after': '7' } }] });
    const r = await provider.sendBatch(msg());
    expect(r).toMatchObject({ success: false, retryable: true, retryAfterMs: 7000 });
  });

  it('retries a network error', async () => {
    const { provider } = fakeSlack({ 'conversations.open': [new Error('ECONNRESET')] });
    expect(await provider.sendBatch(msg())).toMatchObject({ success: false, retryable: true });
  });

  it('fails a recipient with no Slack user ID, and refuses more than one per call', async () => {
    const { provider, calls } = fakeSlack({});
    expect(await provider.sendBatch(msg({ personalizations: [] }))).toMatchObject({ success: false, retryable: false });
    const two = msg().personalizations.concat(msg().personalizations);
    expect(await provider.sendBatch(msg({ personalizations: two }))).toMatchObject({ success: false, retryable: false });
    expect(calls).toHaveLength(0);
  });

  it('refuses a message over the limit without calling Slack', async () => {
    const { provider, calls } = fakeSlack({});
    const r = await provider.sendBatch(msg({ bodyText: 'x'.repeat(MAX_SLACK_MESSAGE_CHARS + 1) }));
    expect(r).toMatchObject({ success: false, retryable: false });
    expect(calls).toHaveLength(0);
  });

  it('addresses only well-formed Slack user IDs', () => {
    const { provider } = fakeSlack({});
    const base = { id: 'r', send_id: 's', person_id: null, email: 'a@b.c', timezone: null };
    expect(provider.resolveAddress({ ...base, slack_user_id: ' U0ABC12 ' })).toBe('U0ABC12');
    expect(provider.resolveAddress({ ...base, slack_user_id: 'W0ABC12' })).toBe('W0ABC12');
    expect(provider.resolveAddress({ ...base, slack_user_id: '<!channel>' })).toBeNull();
    expect(provider.resolveAddress({ ...base, slack_user_id: null })).toBeNull();
    expect(provider.maxPerCall).toBe(1);
    expect(provider.writesSendLog).toBe(false);
  });
});

describe('classifySlackError / renderSlackText', () => {
  it('classifies', () => {
    expect(classifySlackError('token_revoked')).toBe('auth');
    expect(classifySlackError('user_disabled')).toBe('permanent');
    expect(classifySlackError('ratelimited')).toBe('retry');
    expect(classifySlackError(undefined)).toBe('retry');
  });

  it('substitutes in one pass, so a value containing a token is not expanded again', () => {
    expect(renderSlackText('{{a}} {{b}}', { '{{a}}': '{{b}}', '{{b}}': 'x' })).toBe('{{b}} x');
  });
});
