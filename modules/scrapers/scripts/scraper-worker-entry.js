/**
 * BullMQ worker entry point for scraper:run jobs.
 *
 * Wraps the scraper-job-handler to conform to the (job) => Promise<void>
 * signature expected by the Gatewaze module worker system.
 */

import { createClient } from '@supabase/supabase-js';
import { initScraperHandler, runScraperJob } from './scraper-job-handler.js';
import { createRequire } from 'module';
import path from 'path';

let initialized = false;

function ensureInitialized() {
  if (initialized) return;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for scraper worker');
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Import addJob and JobTypes from the core API
  let addJob, JobTypes;
  try {
    const require = createRequire(import.meta.url);
    const jobQueue = require(path.resolve(process.cwd(), 'packages/api/dist/lib/job-queue.js'));
    addJob = jobQueue.addJob;
    JobTypes = jobQueue.JobTypes;
  } catch {
    // Fallback: no-op addJob (scraper chaining won't work but individual runs will)
    addJob = async () => ({ id: 'noop' });
    JobTypes = {};
  }

  initScraperHandler({ supabase, addJob, JobTypes });
  initialized = true;
}

/**
 * BullMQ job handler for scraper:run jobs.
 * @param {import('bullmq').Job} job
 */
function redisConnFromEnv() {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        port: parseInt(u.port || '6379', 10),
        password: u.password || undefined,
        maxRetriesPerRequest: null,
      };
    } catch {
      // fall through
    }
  }
  return {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
  };
}

export default async function handler(job) {
  ensureInitialized();

  const { scraperJobId, scraperName } = job.data;
  // The admin "Running Scrapers" modal tails an SSE stream that api.ts backs
  // with Redis pub/sub on `scraper:<jobId>:logs`. Publish log/progress/
  // complete events there so the UI updates live and its completion counter
  // advances. ioredis is resolved from the API package (not a module dep).
  const channel = `scraper:${scraperJobId}:logs`;
  let publisher = null;
  try {
    const req = createRequire(path.resolve(process.cwd(), 'packages/api/package.json'));
    const IORedis = req('ioredis').default || req('ioredis');
    publisher = new IORedis(redisConnFromEnv());
  } catch {
    // Streaming degrades to worker logs only; the job still runs + records
    // its status via updateJobStatus in the handler.
  }
  const publish = (payload) => {
    if (!publisher) return;
    try {
      publisher
        .publish(channel, JSON.stringify({ ...payload, timestamp: new Date().toISOString() }))
        .catch(() => {});
    } catch {
      // non-fatal — never let a streaming hiccup fail the scrape
    }
  };

  const logger = {
    log: (message) => {
      console.log(`[scraper:${scraperName}] ${message}`);
      job.log(message).catch(() => {});
      publish({ type: 'log', message: String(message) });
    },
    error: (message) => {
      const m = message instanceof Error ? message.message : String(message);
      console.error(`[scraper:${scraperName}] ${m}`);
      job.log(`ERROR: ${m}`).catch(() => {});
      publish({ type: 'log', message: `ERROR: ${m}` });
    },
    progress: (stats) => {
      publish({ type: 'progress', stats: stats || {} });
    },
    complete: (success, result) => {
      publish(success ? { type: 'complete' } : { type: 'error', error: (result && result.error) || 'Scraper failed' });
    },
  };

  try {
    await runScraperJob(scraperJobId, logger, job);
  } finally {
    if (publisher) {
      try { await publisher.quit(); } catch { /* ignore */ }
    }
  }
}
