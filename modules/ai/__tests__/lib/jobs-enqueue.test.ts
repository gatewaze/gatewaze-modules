/**
 * Tests for lib/jobs/enqueue.ts — semaphore gating + the
 * release-on-finally contract.
 *
 * Uses an in-memory key/value harness instead of real Redis.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, number>();

vi.mock('../../lib/jobs/redis-client.js', () => ({
  __resetForTests: () => {},
  pingRedis: async () => true,
  getRedisClient: async () => ({
    incr: async (k: string) => {
      const next = (store.get(k) ?? 0) + 1;
      store.set(k, next);
      return next;
    },
    decr: async (k: string) => {
      const next = (store.get(k) ?? 0) - 1;
      store.set(k, next);
      return next;
    },
    expire: async (_k: string, _seconds: number) => 1,
    set: async (k: string, v: number) => {
      store.set(k, Number(v));
      return 'OK';
    },
  }),
  getRedisSubscriber: async () => ({
    on: () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
  }),
  createDedicatedRedisClient: async () => ({}),
}));

vi.mock('../../lib/jobs/metrics.js', () => ({
  recordEnqueued: vi.fn(async () => {}),
  recordCompleted: vi.fn(async () => {}),
  incConcurrency: vi.fn(async () => {}),
  recordStreamEntry: vi.fn(async () => {}),
  adjustStreamConsumers: vi.fn(async () => {}),
  recordStalled: vi.fn(async () => {}),
  setQueueDepth: vi.fn(async () => {}),
  getMetricsRegistry: vi.fn(async () => null),
}));

const { enqueueChatRunJob, enqueueRecipeRunJob, releaseUseCaseSemaphore } =
  await import('../../lib/jobs/enqueue.js');

beforeEach(() => {
  store.clear();
});

describe('enqueueRecipeRunJob', () => {
  it('enqueues without delay when under cap', async () => {
    const enq = vi.fn(async () => ({ id: 'job-1' }));
    const r = await enqueueRecipeRunJob(enq, {
      runId: 'r-1',
      useCase: 'uc-test',
    });
    expect(r.delayed).toBe(false);
    expect(r.jobId).toBe('job-1');
    expect(enq).toHaveBeenCalledWith(
      'jobs',
      'ai:run-recipe',
      expect.objectContaining({ runId: 'r-1', useCase: 'uc-test' }),
    );
  });

  it('marks delayed=true when use_case cap exceeded', async () => {
    const enq = vi.fn(async () => ({ id: 'job-x' }));
    // Default cap = 4 (AI_USE_CASE_DEFAULT_CAP). Fill the semaphore.
    for (let i = 0; i < 4; i++) {
      await enqueueRecipeRunJob(enq, { runId: `r-${i}`, useCase: 'uc-cap' });
    }
    const r = await enqueueRecipeRunJob(enq, { runId: 'r-overflow', useCase: 'uc-cap' });
    expect(r.delayed).toBe(true);
    const lastCall = enq.mock.calls.at(-1)!;
    expect((lastCall[2] as Record<string, unknown>)._delayHintMs).toBeDefined();
  });

  it('different use_cases have isolated semaphores', async () => {
    const enq = vi.fn(async () => ({ id: 'job-y' }));
    for (let i = 0; i < 4; i++) {
      await enqueueRecipeRunJob(enq, { runId: `a-${i}`, useCase: 'uc-A' });
    }
    // useCase B should be fresh, no delay.
    const r = await enqueueRecipeRunJob(enq, { runId: 'b-0', useCase: 'uc-B' });
    expect(r.delayed).toBe(false);
  });

  it('releaseUseCaseSemaphore decrements the counter', async () => {
    const enq = vi.fn(async () => ({ id: 'job-z' }));
    await enqueueRecipeRunJob(enq, { runId: 'r-1', useCase: 'uc-rel' });
    await enqueueRecipeRunJob(enq, { runId: 'r-2', useCase: 'uc-rel' });
    await releaseUseCaseSemaphore('uc-rel');
    // After 2 INCR + 1 DECR, store should be 1.
    const keys = [...store.entries()].find(([k]) => k.includes('uc-rel'));
    expect(keys?.[1]).toBe(1);
  });

  it('releaseUseCaseSemaphore floors at 0 (no negative leak)', async () => {
    await releaseUseCaseSemaphore('uc-never-incremented');
    const keys = [...store.entries()].find(([k]) => k.includes('uc-never-incremented'));
    // Got reset to 0 by the underflow-recovery branch.
    expect(keys?.[1]).toBe(0);
  });
});

describe('enqueueChatRunJob', () => {
  it('enqueues onto the jobs queue under name ai:run-chat', async () => {
    const enq = vi.fn(async () => ({ id: 'chat-1' }));
    const r = await enqueueChatRunJob(enq, {
      threadId: 't-1',
      assistantMessageId: 'm-1',
      useCase: 'uc-chat',
    });
    expect(r.delayed).toBe(false);
    expect(enq).toHaveBeenCalledWith(
      'jobs',
      'ai:run-chat',
      expect.objectContaining({
        threadId: 't-1',
        assistantMessageId: 'm-1',
        useCase: 'uc-chat',
      }),
    );
  });

  it('shares the same semaphore as recipe for the same use_case', async () => {
    const enq = vi.fn(async () => ({ id: 'mix' }));
    for (let i = 0; i < 4; i++) {
      await enqueueRecipeRunJob(enq, { runId: `r-${i}`, useCase: 'uc-mix' });
    }
    const r = await enqueueChatRunJob(enq, {
      threadId: 't-mix',
      assistantMessageId: 'm-mix',
      useCase: 'uc-mix',
    });
    expect(r.delayed).toBe(true);
  });
});
