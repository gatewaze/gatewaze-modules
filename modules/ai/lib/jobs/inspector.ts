/**
 * BullMQ Queue → admin-facing AdminJobDto serialisation + per-row
 * lookups for the Jobs tab.
 *
 * Uses BullMQ's runtime API directly (rather than calling through the
 * platform's worker context) because the API process has the Queue
 * handle already wired up at startup. We require()-resolve `bullmq`
 * the same way the scrapers module does.
 *
 * Spec: spec-ai-job-runner §5.2, §5.4.
 */

import { createRequire } from 'node:module';
import { getRedisClient } from './redis-client.js';
import { recipeRunStreamKey, threadStreamKey } from './stream-keys.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BullJob = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BullQueue = any;

export type AdminJobStatus = 'active' | 'waiting' | 'delayed' | 'failed' | 'completed';

export interface AdminJobDto {
  id: string;
  name: string;
  status: AdminJobStatus;
  attempts_made: number;
  attempts_remaining: number;
  created_at: string;
  processed_on: string | null;
  finished_on: string | null;
  /**
   * For status='delayed' jobs only: ISO timestamp of when the job is
   * scheduled to fire (timestamp + delay_ms). Null for active / waiting
   * / failed / completed states. The admin UI uses this to render
   * "Fires at HH:MM:SS" / "Fires in Xm" instead of the misleading
   * "Delayed Xm ago" wording, which actually reflects descriptor age,
   * not overdue-ness.
   */
  scheduled_for: string | null;
  data: Record<string, unknown>;
  failed_reason: string | null;
  stacktrace: string[] | null;
  owner_module: string;
  linked_row:
    | {
        table: string;
        id: string;
      }
    | null;
  stream_key: string | null;
  stream_offset_latest: string | null;
}

/**
 * Resolve a BullMQ Queue handle for the shared `jobs` queue. The
 * caller's project root is needed because the platform host runtime
 * (gatewaze/packages/api) holds the bullmq dep — we resolve through
 * that module graph to share the connection.
 *
 * `queueName` defaults to the brand-suffixed `jobs-${BRAND}` shape
 * scrapers use; pass an explicit name for tests.
 */
export async function getJobsQueue(opts: {
  projectRoot: string;
  queueName?: string;
}): Promise<BullQueue> {
  // Platform's shared module queue is named 'jobs' (see
  // packages/api/src/lib/queue/index.ts:86 — `registerQueue({ name: 'jobs', … })`).
  // The brand suffix is the scrapers module's own standalone-queue
  // convention, NOT the platform's; AI jobs go through ctx.enqueueJob
  // which targets 'jobs'.
  const queueName = opts.queueName ?? 'jobs';
  // Resolve bullmq through the API package's module graph so we
  // share the version + connection options the platform uses.
  const apiPkg = `${opts.projectRoot}/packages/api/package.json`;
  const req = createRequire(apiPkg);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bullmq = req('bullmq') as { Queue: new (name: string, opts: unknown) => BullQueue };
  const client = await getRedisClient();
  // CRITICAL: prefix must match the platform's BullMQ config so we
  // read from the same Redis keyspace. Platform's
  // packages/api/src/lib/queue/registry.ts uses
  //   `bull:${BRAND ?? 'default'}`
  // so Redis keys land at bull:default:jobs:... (default-prefix
  // would put us at bull:jobs:... — a different, empty keyspace).
  const prefix = `bull:${process.env.BRAND ?? 'default'}`;
  return new bullmq.Queue(queueName, { connection: client, prefix });
}

/**
 * Convert a BullMQ Job to the admin DTO. The state must be passed in
 * separately because BullMQ's Job.getState() is async — caller resolves
 * it once per batch for efficiency.
 */
export async function jobToDto(job: BullJob, state: string): Promise<AdminJobDto> {
  const name = String(job.name ?? 'unknown');
  const data = (job.data as Record<string, unknown>) ?? {};
  const ownerModule = deriveOwnerModule(name);
  const linkedRow = deriveLinkedRow(name, data);
  const streamKey = deriveStreamKey(name, data);
  let streamOffsetLatest: string | null = null;
  if (streamKey) {
    streamOffsetLatest = await readLastStreamId(streamKey);
  }
  // For delayed jobs, BullMQ stores the "fire at" timestamp on
  // job.opts.timestamp (when the job was created) PLUS job.opts.delay
  // (ms to wait). Repeatable-job descriptors also expose
  // opts.repeat.prevMillis = the scheduled fire time. Prefer the
  // explicit timestamp+delay sum for accuracy; fall back to the repeat
  // descriptor's nrjid-derived timestamp when present.
  let scheduledFor: string | null = null;
  if (state === 'delayed') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = job.opts as any;
    const timestamp = Number(opts?.timestamp ?? job.timestamp ?? 0);
    const delay = Number(opts?.delay ?? 0);
    if (timestamp > 0 && delay >= 0) {
      scheduledFor = new Date(timestamp + delay).toISOString();
    }
  }

  return {
    id: String(job.id ?? ''),
    name,
    status: state as AdminJobStatus,
    attempts_made: Number(job.attemptsMade ?? 0),
    attempts_remaining: Math.max(0, Number(job.opts?.attempts ?? 1) - Number(job.attemptsMade ?? 0)),
    created_at: new Date(Number(job.timestamp ?? Date.now())).toISOString(),
    processed_on: job.processedOn ? new Date(Number(job.processedOn)).toISOString() : null,
    finished_on: job.finishedOn ? new Date(Number(job.finishedOn)).toISOString() : null,
    scheduled_for: scheduledFor,
    data,
    failed_reason: job.failedReason ? String(job.failedReason) : null,
    stacktrace: Array.isArray(job.stacktrace) ? job.stacktrace.slice(0, 3).map(String) : null,
    owner_module: ownerModule,
    linked_row: linkedRow,
    stream_key: streamKey,
    stream_offset_latest: streamOffsetLatest,
  };
}

function deriveOwnerModule(name: string): string {
  if (name.startsWith('ai:')) return 'ai';
  if (name.startsWith('ai.')) return 'ai';
  if (name.startsWith('scraper:')) return 'scrapers';
  // Convention from premium-gatewaze-modules: '<module>:<action>' or
  // '<module>.<action>'. Take the prefix up to the first separator.
  const m = /^([a-z0-9_-]+)[:.]/.exec(name);
  if (m) return m[1]!;
  return 'unknown';
}

function deriveLinkedRow(
  name: string,
  data: Record<string, unknown>,
): { table: string; id: string } | null {
  if (name === 'ai:run-recipe' && typeof data.runId === 'string') {
    return { table: 'ai_recipe_runs', id: data.runId };
  }
  if (name === 'ai:run-chat' && typeof data.assistantMessageId === 'string') {
    return { table: 'ai_messages', id: data.assistantMessageId };
  }
  if (name === 'scraper:run' && typeof data.scraperJobId !== 'undefined') {
    return { table: 'scrapers_jobs', id: String(data.scraperJobId) };
  }
  return null;
}

function deriveStreamKey(name: string, data: Record<string, unknown>): string | null {
  if (name === 'ai:run-recipe' && typeof data.runId === 'string') {
    return recipeRunStreamKey(data.runId);
  }
  if (name === 'ai:run-chat' && typeof data.threadId === 'string') {
    return threadStreamKey(data.threadId);
  }
  return null;
}

async function readLastStreamId(streamKey: string): Promise<string | null> {
  try {
    const client = await getRedisClient();
    // XINFO STREAM <key> returns a flat array of [field, value, …].
    // 'last-generated-id' is the relevant field.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (await client.xinfo('STREAM', streamKey)) as unknown as Array<string>;
    for (let i = 0; i + 1 < info.length; i += 2) {
      if (info[i] === 'last-generated-id') {
        const v = info[i + 1] as string | undefined;
        if (!v || v === '0-0') return null;
        return v;
      }
    }
    return null;
  } catch {
    // Stream may not exist (job done > TTL). Treat as null.
    return null;
  }
}

export type ListJobsFilter = {
  states?: AdminJobStatus[];
  name?: string;  // exact match
  prefix?: string; // e.g. 'ai:' — name.startsWith(prefix)
  limit?: number;
  offset?: number;
};

/**
 * List jobs from the queue matching the filter. Returns DTOs in
 * (created_at DESC) order.
 */
export async function listJobs(
  queue: BullQueue,
  filter: ListJobsFilter,
): Promise<{ jobs: AdminJobDto[]; total: number }> {
  const states = filter.states ?? ['active', 'waiting', 'delayed', 'failed'];
  const limit = Math.min(filter.limit ?? 100, 200);
  const offset = filter.offset ?? 0;
  // BullMQ's getJobs accepts a state list directly.
  const jobs = (await queue.getJobs(states, 0, offset + limit * 4, false)) as BullJob[];
  // Filter by name client-side because BullMQ doesn't have an indexed
  // "by name" lookup on the union of states.
  const filtered = jobs.filter((j) => {
    const n = String(j.name ?? '');
    if (filter.name && n !== filter.name) return false;
    if (filter.prefix && !n.startsWith(filter.prefix)) return false;
    return true;
  });
  const paged = filtered.slice(offset, offset + limit);
  const dtos = await Promise.all(
    paged.map(async (j) => {
      const state = (await j.getState()) as string;
      return jobToDto(j, state);
    }),
  );
  return { jobs: dtos, total: filtered.length };
}

/**
 * Single-job inspect. Returns null when the job ID is unknown.
 */
export async function getJob(queue: BullQueue, jobId: string): Promise<AdminJobDto | null> {
  const job = (await queue.getJob(jobId)) as BullJob | null;
  if (!job) return null;
  const state = (await job.getState()) as string;
  return jobToDto(job, state);
}
