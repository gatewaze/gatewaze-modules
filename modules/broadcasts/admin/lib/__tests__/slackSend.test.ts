import { describe, it, expect, vi, beforeEach } from 'vitest';

// A minimal PostgREST stand-in for the calls createSlackBroadcastSend makes.
const inserted: Record<string, unknown>[] = [];
let parent: Record<string, unknown> = {};
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: table === 'broadcasts' ? parent : null, error: null }) }),
      }),
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { select: () => ({ single: async () => ({ data: { id: 'new-send' }, error: null }) }) };
      },
    }),
  },
}));

const { createSlackBroadcastSend, createBroadcastSend } = await import('../broadcastService');

const base = {
  id: 'b1', name: 'VAF Slack', brand: 'aaif', channel: 'slack', slack_sender: 'welcome_sender',
  audience_type: 'segment', segment_id: 'seg1', include_prospects: false, event_id: null, body_text: 'Hi {{first_name}}',
};

describe('createSlackBroadcastSend', () => {
  beforeEach(() => { inserted.length = 0; parent = { ...base }; });

  it('creates a scheduled Slack send with the slack opt-out topic and the chosen sender', async () => {
    const out = await createSlackBroadcastSend('b1', { scheduledAt: null, excludeSentSendIds: ['prev'] });
    expect(out).toEqual({ id: 'new-send' });
    expect(inserted[0]).toMatchObject({
      broadcast_id: 'b1', channel: 'slack', audience_type: 'segment', segment_id: 'seg1',
      suppression_topic: 'slack', status: 'scheduled', schedule_type: 'immediate', delivery_strategy: 'global',
      body_text: 'Hi {{first_name}}', exclude_sent_send_ids: ['prev'], metadata: { slack_sender: 'welcome_sender' },
    });
    expect(typeof inserted[0].scheduled_at).toBe('string');
  });

  it.each([
    [{ channel: 'email' }, /not a Slack broadcast/],
    [{ segment_id: null }, /audience/],
    [{ body_text: '  ' }, /message/],
    [{ body_text: 'x'.repeat(4001) }, /4000/],
  ])('refuses %o', async (patch, msg) => {
    parent = { ...base, ...patch };
    await expect(createSlackBroadcastSend('b1', { scheduledAt: null, excludeSentSendIds: [] })).rejects.toThrow(msg);
    expect(inserted).toHaveLength(0);
  });

  it('keeps the email composer away from Slack broadcasts', async () => {
    await expect(createBroadcastSend('b1', { scheduleType: 'immediate', scheduledAt: null, deliveryStrategy: 'global', targetLocal: null, defaultTimezone: null, excludeSentSendIds: [] }))
      .rejects.toThrow(/Slack/);
    expect(inserted).toHaveLength(0);
  });
});
