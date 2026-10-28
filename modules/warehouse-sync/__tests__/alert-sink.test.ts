import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatAlert, postSlackBot, deliverAlert } from '../lib/alert-sink';

const alert = {
  slot_name: 'snowflake_cdc',
  code: 'slot_invalidated',
  severity: 'critical',
  message: 'slot WAL is unreserved',
};

/** Minimal supabase stub: .from(t).select().eq().maybeSingle() -> {data}. */
const supabaseWith = (config: Record<string, unknown> | null) => ({
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: config ? { config } : null }) }),
    }),
  }),
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('formatAlert', () => {
  it('names the slot, code and severity', () => {
    expect(formatAlert(alert)).toContain('CRITICAL');
    expect(formatAlert(alert)).toContain('snowflake_cdc/slot_invalidated');
    expect(formatAlert(alert)).toContain('slot WAL is unreserved');
  });

  it('copes with a null slot name (slot_missing)', () => {
    const s = formatAlert({ ...alert, slot_name: null, code: 'slot_missing' });
    expect(s).toContain('slot_missing');
    expect(s).not.toContain('null');
  });
});

describe('postSlackBot', () => {
  it('treats ok:false as a failure even though Slack returns HTTP 200', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ ok: false, error: 'channel_not_found' }) });
    expect(await postSlackBot('xoxb-t', 'C123', alert)).toBe(false);
  });

  it('returns true on ok:true', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
    expect(await postSlackBot('xoxb-t', 'C123', alert)).toBe(true);
  });

  it('sends a bearer token and the channel', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
    await postSlackBot('xoxb-t', 'U999', alert);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.headers.authorization).toBe('Bearer xoxb-t');
    expect(JSON.parse(init.body).channel).toBe('U999');
  });

  it('does nothing without a token or channel', async () => {
    expect(await postSlackBot('', 'C1', alert)).toBe(false);
    expect(await postSlackBot('xoxb-t', '', alert)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives a network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    expect(await postSlackBot('xoxb-t', 'C1', alert)).toBe(false);
  });
});

describe('deliverAlert', () => {
  it('prefers the webhook when both are set', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const sent = await deliverAlert(
      alert,
      { alertWebhookUrl: 'https://hooks.example/x', alertSlackChannel: 'C1' },
      supabaseWith({ SLACK_BOT_TOKEN: 'xoxb-t' }) as any,
    );
    expect(sent).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://hooks.example/x');
  });

  it('falls back to the slack module token when only a channel is set', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
    const sent = await deliverAlert(
      alert,
      { alertSlackChannel: 'U999' },
      supabaseWith({ SLACK_BOT_TOKEN: 'xoxb-t' }) as any,
    );
    expect(sent).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://slack.com/api/chat.postMessage');
  });

  /** The 2026-10-28 condition: detection fine, nowhere to send. */
  it('reports not-delivered when neither sink is configured', async () => {
    const sent = await deliverAlert(alert, {}, supabaseWith({ SLACK_BOT_TOKEN: 'xoxb-t' }) as any);
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports not-delivered when a channel is set but the slack module has no token', async () => {
    const sent = await deliverAlert(alert, { alertSlackChannel: 'C1' }, supabaseWith({}) as any);
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not throw when the slack module is not installed', async () => {
    const sent = await deliverAlert(alert, { alertSlackChannel: 'C1' }, supabaseWith(null) as any);
    expect(sent).toBe(false);
  });
});
