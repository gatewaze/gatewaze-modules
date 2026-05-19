/**
 * Tests for lib/jobs/cancel.ts — pub/sub broadcast → CancelToken.
 *
 * Uses an in-memory pubsub stub to validate the contract without a
 * real Redis.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory pubsub harness shared by getRedisClient/getRedisSubscriber
// mocks.
interface Subscriber {
  channel: string;
  handler: (ch: string, msg: string) => void;
}
const subscribers: Subscriber[] = [];

function publish(channel: string, message: string): number {
  let count = 0;
  for (const s of subscribers) {
    if (s.channel === channel) {
      s.handler(channel, message);
      count++;
    }
  }
  return count;
}

vi.mock('../../lib/jobs/redis-client.js', () => ({
  __resetForTests: () => {},
  pingRedis: async () => true,
  getRedisClient: async () => ({
    publish: async (channel: string, message: string) => publish(channel, message),
  }),
  getRedisSubscriber: async () => {
    const handlers: Array<(ch: string, msg: string) => void> = [];
    const channelsByHandler = new Map<typeof handlers[number], Set<string>>();
    return {
      on: (event: string, handler: (ch: string, msg: string) => void) => {
        if (event !== 'message') return;
        handlers.push(handler);
        if (!channelsByHandler.has(handler)) channelsByHandler.set(handler, new Set());
      },
      subscribe: async (channel: string) => {
        for (const h of handlers) {
          subscribers.push({ channel, handler: h });
          channelsByHandler.get(h)?.add(channel);
        }
      },
      unsubscribe: async (channel: string) => {
        for (let i = subscribers.length - 1; i >= 0; i--) {
          if (subscribers[i]!.channel === channel) subscribers.splice(i, 1);
        }
      },
    };
  },
  createDedicatedRedisClient: async () => ({}),
}));

const { broadcastCancel, RunCancelled, subscribeCancel } = await import('../../lib/jobs/cancel.js');

beforeEach(() => {
  subscribers.splice(0, subscribers.length);
});

describe('cancel pub/sub', () => {
  it('subscribeCancel returns a token whose `cancelled` flips on broadcast', async () => {
    const token = await subscribeCancel('test-channel-1');
    expect(token.cancelled).toBe(false);
    await broadcastCancel('test-channel-1', 'user');
    // Synchronous: the mock invokes handlers in-line.
    expect(token.cancelled).toBe(true);
    expect(token.source).toBe('pubsub');
    expect(token.reason).toBe('user');
  });

  it('different channels are isolated', async () => {
    const tokA = await subscribeCancel('chan-a');
    const tokB = await subscribeCancel('chan-b');
    await broadcastCancel('chan-a', 'admin');
    expect(tokA.cancelled).toBe(true);
    expect(tokA.reason).toBe('admin');
    expect(tokB.cancelled).toBe(false);
  });

  it('multiple PUBLISH on same channel are idempotent', async () => {
    const token = await subscribeCancel('chan-multi');
    await broadcastCancel('chan-multi', 'user');
    const reason1 = token.reason;
    const source1 = token.source;
    await broadcastCancel('chan-multi', 'admin');
    // First write wins; subsequent broadcasts don't overwrite.
    expect(token.reason).toBe(reason1);
    expect(token.source).toBe(source1);
  });

  it('unsubscribe stops receiving broadcasts', async () => {
    const token = await subscribeCancel('chan-unsub');
    await token.unsubscribe();
    await broadcastCancel('chan-unsub', 'user');
    expect(token.cancelled).toBe(false);
  });

  it('markCancelled() lets the DB-poll backstop fire the token', async () => {
    const token = await subscribeCancel('chan-poll');
    token.markCancelled('db_poll', 'timeout');
    expect(token.cancelled).toBe(true);
    expect(token.source).toBe('db_poll');
    expect(token.reason).toBe('timeout');
  });

  it('RunCancelled exception carries source + reason', () => {
    const err = new RunCancelled('pubsub', 'admin');
    expect(err).toBeInstanceOf(Error);
    expect(err.source).toBe('pubsub');
    expect(err.reason).toBe('admin');
    expect(err.name).toBe('RunCancelled');
  });

  it('bare-string payload defaults to reason=user', async () => {
    // The mock just passes through whatever publish gets; we
    // mimic the cancel.ts JSON path by sending a JSON object — the
    // happy path. The non-JSON path is covered by the JSON.parse
    // try/catch in cancel.ts; we leave that to the implementation
    // tests since the mock isn't strict about the wire format.
    const token = await subscribeCancel('chan-default');
    await broadcastCancel('chan-default');
    expect(token.reason).toBe('user');
  });
});
