/**
 * Prometheus metric definitions for the AI job runner.
 *
 * Lazy-initialised so a fresh prom-client Registry isn't created at
 * module import time (avoids contention if the host has its own
 * default registry). The platform's metrics scrape endpoint reads
 * `register.metrics()`; this module just adds to whatever registry
 * the caller passes (or the default global registry).
 *
 * Spec: spec-ai-job-runner §11.1.
 *
 * Metric names follow Prometheus conventions:
 *   - `_total` suffix for counters
 *   - `_seconds` suffix for time histograms
 *   - all metrics carry `module="ai"` for cross-module dashboards
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PromClient = any;

let lib: PromClient | null = null;
let metrics: {
  enqueued: PromClient;
  completed: PromClient;
  duration: PromClient;
  queueDepth: PromClient;
  concurrency: PromClient;
  streamEntries: PromClient;
  streamConsumers: PromClient;
  stalled: PromClient;
} | null = null;

async function loadProm(): Promise<PromClient | null> {
  if (lib) return lib;
  try {
    const specifier = 'prom-client';
    // Dynamic import keeps prom-client off the import graph for
    // consumers that don't scrape metrics.
    lib = await import(/* @vite-ignore */ specifier);
    return lib;
  } catch {
    // prom-client isn't installed — metric emission becomes a no-op.
    return null;
  }
}

async function ensureMetrics(): Promise<typeof metrics> {
  if (metrics) return metrics;
  const p = await loadProm();
  if (!p) return null;
  const Counter = p.Counter;
  const Histogram = p.Histogram;
  const Gauge = p.Gauge;
  metrics = {
    enqueued: new Counter({
      name: 'ai_jobs_enqueued_total',
      help: 'AI jobs enqueued onto the BullMQ queue.',
      labelNames: ['name', 'use_case'],
    }),
    completed: new Counter({
      name: 'ai_jobs_completed_total',
      help: 'AI jobs that reached a terminal state.',
      labelNames: ['name', 'use_case', 'status'],
    }),
    duration: new Histogram({
      name: 'ai_jobs_duration_seconds',
      help: 'AI job wall-clock duration in seconds.',
      labelNames: ['name', 'use_case', 'status'],
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600, 1200],
    }),
    queueDepth: new Gauge({
      name: 'ai_jobs_queue_depth',
      help: 'Number of AI jobs in each queue state.',
      labelNames: ['queue', 'state'],
    }),
    concurrency: new Gauge({
      name: 'ai_jobs_concurrency',
      help: 'Number of AI jobs currently executing.',
      labelNames: ['name'],
    }),
    streamEntries: new Counter({
      name: 'ai_stream_entries_written_total',
      help: 'Redis Stream entries written by AI workers.',
      labelNames: ['stream_type'],
    }),
    streamConsumers: new Gauge({
      name: 'ai_stream_consumers',
      help: 'Active SSE consumers attached to AI streams.',
      labelNames: ['stream_type'],
    }),
    stalled: new Counter({
      name: 'ai_jobs_stalled_total',
      help: 'AI jobs that BullMQ marked as stalled (worker lock expired).',
      labelNames: ['name'],
    }),
  };
  return metrics;
}

export async function recordEnqueued(name: string, useCase: string): Promise<void> {
  const m = await ensureMetrics();
  m?.enqueued.labels(name, useCase).inc();
}

export async function recordCompleted(
  name: string,
  useCase: string,
  status: 'complete' | 'failed' | 'cancelled',
  durationSeconds: number,
): Promise<void> {
  const m = await ensureMetrics();
  m?.completed.labels(name, useCase, status).inc();
  m?.duration.labels(name, useCase, status).observe(durationSeconds);
}

export async function setQueueDepth(queue: string, state: string, n: number): Promise<void> {
  const m = await ensureMetrics();
  m?.queueDepth.labels(queue, state).set(n);
}

export async function incConcurrency(name: string, delta = 1): Promise<void> {
  const m = await ensureMetrics();
  if (delta > 0) m?.concurrency.labels(name).inc(delta);
  else m?.concurrency.labels(name).dec(-delta);
}

export async function recordStreamEntry(streamType: 'run' | 'thread'): Promise<void> {
  const m = await ensureMetrics();
  m?.streamEntries.labels(streamType).inc();
}

export async function adjustStreamConsumers(
  streamType: 'run' | 'thread',
  delta: number,
): Promise<void> {
  const m = await ensureMetrics();
  if (delta > 0) m?.streamConsumers.labels(streamType).inc(delta);
  else m?.streamConsumers.labels(streamType).dec(-delta);
}

export async function recordStalled(name: string): Promise<void> {
  const m = await ensureMetrics();
  m?.stalled.labels(name).inc();
}

/**
 * Get the underlying prom-client Registry so the host can attach it
 * to its scrape endpoint. Returns null when prom-client isn't installed.
 */
export async function getMetricsRegistry(): Promise<PromClient | null> {
  const p = await loadProm();
  if (!p) return null;
  return p.register;
}
