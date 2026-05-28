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
export default async function handler(job) {
  ensureInitialized();

  const { scraperJobId, scraperName } = job.data;

  // Create a logger that publishes to Redis for SSE streaming
  const logger = {
    log: (message) => {
      console.log(`[scraper:${scraperName}] ${message}`);
      job.log(message).catch(() => {});
    },
    error: (message) => {
      console.error(`[scraper:${scraperName}] ${message}`);
      job.log(`ERROR: ${message}`).catch(() => {});
    },
  };

  await runScraperJob(scraperJobId, logger, job);
}
