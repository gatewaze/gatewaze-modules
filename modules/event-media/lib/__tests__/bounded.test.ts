import { describe, expect, it, vi } from 'vitest';
import { bounded } from '../bounded';

/** A job that resolves when told to. */
function gate() {
  let open!: () => void;
  const done = new Promise<void>((r) => { open = r; });
  return { done, open };
}

describe('bounded', () => {
  it('runs up to the limit at once and no more', async () => {
    const run = bounded(2);
    const gates = [gate(), gate(), gate(), gate()];
    let started = 0;
    for (const g of gates) run(async () => { started += 1; await g.done; });

    // Scheduling is synchronous up to the limit.
    expect(started).toBe(2);
    expect(run.active).toBe(2);
    expect(run.waiting).toBe(2);

    gates[0]!.open();
    await vi.waitFor(() => expect(started).toBe(3));
    expect(run.active).toBe(2);

    for (const g of gates) g.open();
    await vi.waitFor(() => expect(run.active).toBe(0));
    expect(started).toBe(4);
    expect(run.waiting).toBe(0);
  });

  it('runs every job that was queued', async () => {
    const run = bounded(3);
    const seen: number[] = [];
    for (let i = 0; i < 50; i += 1) run(async () => { seen.push(i); });
    await vi.waitFor(() => expect(seen).toHaveLength(50));
    expect(new Set(seen).size).toBe(50);
  });

  it('releases the slot when a job throws, and reports it', async () => {
    const onError = vi.fn();
    const run = bounded(1, onError);
    run(async () => { throw new Error('nope'); });
    const after: string[] = [];
    run(async () => { after.push('ran'); });

    await vi.waitFor(() => expect(after).toEqual(['ran']));
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('nope');
    expect(run.active).toBe(0);
  });

  it('never lets a rejection escape to the process', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const run = bounded(2);
      for (let i = 0; i < 5; i += 1) run(async () => { throw new Error(`boom ${i}`); });
      await vi.waitFor(() => expect(run.active).toBe(0));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // The reporter is the last thing standing between a failed job and an
  // unhandledRejection, so it must not be able to cause one itself.
  it('survives a reporter that throws, and keeps running jobs', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const run = bounded(1, () => { throw new Error('the logger is down'); });
      run(async () => { throw new Error('nope'); });
      const after: string[] = [];
      run(async () => { after.push('ran'); });

      await vi.waitFor(() => expect(after).toEqual(['ran']));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
      expect(run.active).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('treats a limit below one as one', () => {
    const run = bounded(0);
    const g = gate();
    run(async () => { await g.done; });
    run(async () => { await g.done; });
    expect(run.active).toBe(1);
    expect(run.waiting).toBe(1);
    g.open();
  });
});
