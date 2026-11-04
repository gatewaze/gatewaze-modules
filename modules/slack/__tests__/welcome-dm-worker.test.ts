import { describe, it, expect, vi, beforeEach } from 'vitest';

// The worker's decisions, with the database and Slack replaced by fakes.
const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  sender: null as Record<string, unknown> | null,
  prior: { ok: true, found: false, channel: 'D1' } as Record<string, unknown>,
  sent: [] as string[],
}));

vi.mock('../lib/service-client.js', () => {
  const sb = {
    from: () => {
      let patch: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        update: (p: Record<string, unknown>) => { patch = p; state.updates.push(p); return q; },
        eq: () => q,
        select: async () => ({ data: state.row ? [state.row] : [], error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      void patch;
      return q;
    },
  };
  return { serviceClient: () => sb };
});

vi.mock('../lib/welcome-store.js', () => ({
  LOG_TABLE: 'integrations_slack_welcome_log',
  readSlackConfig: async () => ({ enabled: true, message: 'Hi {first_name}' }),
  readSenderWithToken: async () => state.sender,
  markSenderBroken: async () => {},
  findPriorDirectMessage: async () => state.prior,
  sendDirectMessage: async (_t: string, user: string) => { state.sent.push(user); return { ok: true, ts: '9.9' }; },
}));

// @ts-expect-error — plain module, no declarations needed for the test
import welcomeDm from '../workers/welcome-dm.ts';

const job = { data: { logId: 'L1' }, attemptsMade: 0, opts: { attempts: 3 } };

beforeEach(() => {
  state.row = { id: 'L1', team_id: 'T1', slack_user_id: 'U9', first_name: 'Adam', display_name: 'Adam' };
  state.updates = [];
  state.sent = [];
  state.sender = { team_id: 'T1', slack_user_id: 'UDEM', token: 'xoxp', scopes: 'chat:write,im:write,im:history' };
  state.prior = { ok: true, found: false, channel: 'D1' };
});

describe('welcome-dm worker', () => {
  it('sends when the DM is empty', async () => {
    expect(await welcomeDm(job)).toEqual({ sent: true });
    expect(state.sent).toEqual(['U9']);
  });

  it('skips someone who already has messages in a DM with the sender', async () => {
    state.prior = { ok: true, found: true, channel: 'D1' };
    expect(await welcomeDm(job)).toEqual({ skipped: 'prior conversation' });
    expect(state.sent).toEqual([]);
    expect(state.updates.at(-1)).toMatchObject({ status: 'skipped' });
  });

  it('holds the row, without sending or marking the sender broken, when im:history was never granted', async () => {
    state.sender = { ...state.sender, scopes: 'chat:write,im:write' };
    expect(await welcomeDm(job)).toEqual({ held: 'missing scope' });
    expect(state.sent).toEqual([]);
    expect(state.updates.at(-1)).toMatchObject({ status: 'pending' });
  });

  it('holds the row, without marking the sender broken, when Slack refuses the history read', async () => {
    const broken = vi.spyOn(await import('../lib/welcome-store.js'), 'markSenderBroken');
    state.prior = { ok: false, error: 'missing_scope', stage: 'history' };
    expect(await welcomeDm(job)).toEqual({ held: 'missing scope' });
    expect(state.sent).toEqual([]);
    expect(broken).not.toHaveBeenCalled();
    expect(state.updates.at(-1)).toMatchObject({ status: 'pending' });
  });

  it('never sends when the history check fails, and retries it', async () => {
    state.prior = { ok: false, error: 'ratelimited', stage: 'history' };
    await expect(welcomeDm(job)).rejects.toThrow(/ratelimited/);
    expect(state.sent).toEqual([]);
    expect(state.updates.at(-1)).toMatchObject({ status: 'pending' });
  });
});
