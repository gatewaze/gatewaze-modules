import { beforeEach, describe, expect, it, vi } from 'vitest';

const added: Array<[string, unknown, unknown]> = [];
vi.mock('bullmq', () => ({
  Queue: class {
    async add(name: string, data: unknown, opts: unknown) { added.push([name, data, opts]); return { id: 'q1' }; }
    async close() {}
  },
}));

const { enqueueResearchRun } = await import('../enqueue-research-run.js');

beforeEach(() => { added.length = 0; });

describe('enqueueResearchRun', () => {
  it('uses the platform enqueueJob when it returns an id, and never opens a queue', async () => {
    const enqueueJob = vi.fn(async () => ({ id: 'j1' }));
    await enqueueResearchRun('r1', enqueueJob);
    expect(enqueueJob).toHaveBeenCalledWith('jobs', 'newsletters:research-run', { kind: 'newsletters:research-run', runId: 'r1' }, expect.objectContaining({ jobId: 'newsletters-research-run-r1' }));
    expect(added).toHaveLength(0);
  });

  it('falls back to a direct queue with no enqueueJob (the legacy worker passes no context)', async () => {
    await enqueueResearchRun('r2');
    expect(added).toEqual([['newsletters:research-run', { kind: 'newsletters:research-run', runId: 'r2' }, expect.objectContaining({ jobId: 'newsletters-research-run-r2' })]]);
  });

  it('falls back when enqueueJob resolves without an id (queue not registered)', async () => {
    await enqueueResearchRun('r3', async () => ({ id: undefined }));
    expect(added).toHaveLength(1);
  });
});
