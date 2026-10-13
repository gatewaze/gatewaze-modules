// @ts-nocheck — vitest harness.

/**
 * The platform worker calls processQueue() on a timer. With nothing queued it
 * must not start a browser: launching Chromium every tick leaked zombie
 * processes until the container ran out of PIDs ("Cannot fork").
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const constructed = vi.fn();
vi.mock('../scripts/SlackInvitationManager.js', () => ({
  SlackInvitationManager: class {
    constructor(opts) { constructed(opts); }
    async initialize() {}
    async ensureAuthenticated() {}
    async inviteUser() { return { success: true }; }
    async cleanup() {}
  },
}));

const { initSlackWorker, processQueue } = await import('../scripts/slack-invitation-worker.js');

/** A supabase stub whose pending-invitations RPC returns `queue` in turn. */
function stub(queue: Array<{ data?: unknown; error?: unknown }>) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'integrations_get_pending_slack_invitations') return queue.shift() ?? { data: [], error: null };
    return { data: null, error: null };
  });
  const from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) });
  return { rpc, from };
}

beforeEach(() => {
  constructed.mockClear();
  delete process.env.SLACK_PROXY_URL;
  delete process.env.SLACK_SESSION_SECRET_B64;
});

describe('processQueue when idle', () => {
  it('does not start a browser when nothing is pending', async () => {
    const sb = stub([{ data: [], error: null }]);
    initSlackWorker({ supabase: sb });
    await processQueue();
    expect(constructed).not.toHaveBeenCalled();
    expect(sb.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not start a browser when the queue cannot be read', async () => {
    initSlackWorker({ supabase: stub([{ data: null, error: { message: 'boom' } }]) });
    await processQueue();
    expect(constructed).not.toHaveBeenCalled();
  });

  it('starts the browser when an invitation is waiting', async () => {
    const pending = { data: [{ id: 1, email: 'a@example.com' }], error: null };
    // The look-ahead, then the loop's first read, then empty.
    initSlackWorker({ supabase: stub([pending, pending, { data: [], error: null }]) });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const run = processQueue();
    await vi.runAllTimersAsync();
    await run;
    vi.useRealTimers();
    expect(constructed).toHaveBeenCalledTimes(1);
  });
});
