/**
 * Run detached work a few jobs at a time.
 *
 * The api pod has 512MB for everything it does, and the projector's
 * layer generation holds whole decoded images in it -- a depth map, a
 * cutout and up to two candidate background plates per photograph, each
 * a multi-megapixel PNG or JPEG. One at a time that is affordable. One
 * per upload, fired and not awaited, is not: eighty photographs arriving
 * four at a time put dozens of those in flight at once and the pod was
 * OOMKilled twice on 2026-10-17, taking the site down with it.
 *
 * So the jobs queue instead. Concurrency is bounded; the queue is not,
 * because a queued job is a closure and costs nothing, while a running
 * one costs megabytes. Work is never dropped and never awaited by the
 * request that scheduled it.
 *
 * THERE IS DELIBERATELY NO PER-JOB TIMEOUT. The obvious one makes this
 * worse, not better: a promise cannot be cancelled, so timing a job out
 * hands back its slot while the job carries on holding its images. The
 * bound would then stop bounding memory, which is the only thing it is
 * for. A job that hangs holds its slot, and holding it is correct --
 * that costs throughput, never the pod. A hang that must be survived
 * belongs behind a timeout on the call that hangs, where giving up
 * actually releases the memory.
 */

export interface Runner {
  /** Schedule a job. Returns immediately. */
  (job: () => Promise<void>): void
  /** How many are running right now. */
  readonly active: number
  /** How many are waiting. */
  readonly waiting: number
}

/**
 * A runner that keeps at most `limit` jobs in flight.
 *
 * A job that throws is swallowed: this is detached work, so a rejection
 * reaching the top would surface as an unhandledRejection and take the
 * process down -- which is the very thing the bound is here to prevent.
 */
export function bounded(limit: number, onError?: (err: unknown) => void): Runner {
  const max = Math.max(1, Math.floor(limit))
  const queue: (() => Promise<void>)[] = []
  let active = 0

  const pump = (): void => {
    while (active < max && queue.length > 0) {
      const job = queue.shift()!
      active += 1
      // Start it, then release the slot whatever happens to it.
      void (async () => {
        try {
          await job()
        } catch (err) {
          // Guarded: a reporter that throws would reject this very
          // promise, which nothing awaits, and an unhandledRejection is
          // the process death this whole file exists to prevent.
          try {
            onError?.(err)
          } catch {
            // Nothing left to report it to.
          }
        } finally {
          active -= 1
          pump()
        }
      })()
    }
  }

  const run = ((job: () => Promise<void>): void => {
    queue.push(job)
    pump()
  }) as Runner

  Object.defineProperty(run, 'active', { get: () => active })
  Object.defineProperty(run, 'waiting', { get: () => queue.length })
  return run
}
