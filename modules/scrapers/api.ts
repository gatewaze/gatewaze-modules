/**
 * API routes for the scrapers module.
 *
 * Provides endpoints for managing event scrapers.
 * Heavy scraper execution happens via the job queue worker.
 */

import type { Express, Request, Response } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import { createRequire } from 'module';
import { join } from 'path';

let _supabase: any = null;
let _queue: any = null;
let _Queue: any = null;

function initSupabase(projectRoot: string) {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
  const { createClient } = require('@supabase/supabase-js');
  _supabase = createClient(url, key);
  return _supabase;
}

function getRedisConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      return {
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
        password: url.password || undefined,
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

function isQueueAvailable(): boolean {
  return !!(process.env.REDIS_URL || process.env.REDIS_HOST);
}

const QUEUE_NAME = `jobs-${process.env.BRAND || 'default'}`;

function getQueue(projectRoot: string) {
  if (_queue) return _queue;
  if (!_Queue) {
    const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
    const bullmq = require('bullmq');
    _Queue = bullmq.Queue;
  }
  _queue = new _Queue(QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000, age: 24 * 3600 },
      removeOnFail: { count: 500, age: 7 * 24 * 3600 },
    },
  });
  return _queue;
}

async function addJob(projectRoot: string, type: string, data: Record<string, unknown>) {
  const q = getQueue(projectRoot);
  const safeType = type.replace(/:/g, '-');
  const job = await q.add(type, {
    ...data,
    enqueuedAt: new Date().toISOString(),
  }, {
    jobId: `${safeType}-${Date.now()}`,
  });
  console.log(`Job enqueued: ${type} (${job.id})`);
  return job;
}

const SCRAPER_RUN = 'scraper:run';

export function registerRoutes(app: Express, context?: ModuleContext) {
  const projectRoot = context?.projectRoot || process.cwd();

  // List all scrapers
  app.get('/api/scrapers', async (_req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('scrapers')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, scrapers: data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get scraper details
  app.get('/api/scrapers/:jobId/details', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data: scraper, error } = await supabase
        .from('scrapers')
        .select('*')
        .eq('id', req.params.jobId)
        .single();

      if (error || !scraper) {
        return res.status(404).json({ success: false, error: 'Scraper not found' });
      }

      // Get recent jobs
      const { data: logs } = await supabase
        .from('scrapers_jobs')
        .select('*')
        .eq('scraper_id', req.params.jobId)
        .order('created_at', { ascending: false })
        .limit(20);

      res.json({ success: true, scraper, logs: logs || [] });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get scraper logs
  app.get('/api/scrapers/:jobId/logs', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data: logs, error } = await supabase
        .from('scrapers_jobs')
        .select('*')
        .eq('scraper_id', req.params.jobId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, logs: logs || [] });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Start a scraper via job queue
  app.post('/api/scrapers/:jobId/start', async (req: Request, res: Response) => {
    try {
      if (!isQueueAvailable()) {
        return res.status(503).json({ success: false, error: 'Job queue not available (Redis not configured)' });
      }

      const supabase = initSupabase(projectRoot);
      const scraperJobId = parseInt(req.params.jobId, 10);

      // Look up the scrapers_jobs row and its parent scraper
      const { data: jobRow, error: jobError } = await supabase
        .from('scrapers_jobs')
        .select('id, scraper_id, scrapers(id, name, scraper_type, event_type)')
        .eq('id', scraperJobId)
        .single();

      if (jobError || !jobRow) {
        // Fallback: treat param as scraper ID (direct start without pre-created job)
        const { data: scraper, error } = await supabase
          .from('scrapers')
          .select('id, name, scraper_type, event_type')
          .eq('id', req.params.jobId)
          .single();

        if (error || !scraper) {
          return res.status(404).json({ success: false, error: 'Scraper or job not found' });
        }

        // Create a scrapers_jobs row first
        const { data: newJobs, error: createError } = await supabase.rpc('scrapers_create_job', {
          scraper_ids: [scraper.id],
          created_by_user: 'api'
        });

        if (createError || !newJobs?.length) {
          return res.status(500).json({ success: false, error: 'Failed to create scraper job' });
        }

        const newJobId = newJobs[0].job_id;

        const bullJob = await addJob(projectRoot, SCRAPER_RUN, {
          scraperJobId: newJobId,
          scraperId: scraper.id,
          scraperName: scraper.name,
          scraperType: scraper.scraper_type,
          eventType: scraper.event_type,
          manual: true,
        });

        return res.json({
          success: true,
          message: `Scraper "${scraper.name}" started`,
          jobId: bullJob.id,
          scraperJobId: newJobId,
        });
      }

      // Normal path: scrapers_jobs row already exists
      const scraper = jobRow.scrapers as any;

      const bullJob = await addJob(projectRoot, SCRAPER_RUN, {
        scraperJobId: jobRow.id,
        scraperId: scraper.id,
        scraperName: scraper.name,
        scraperType: scraper.scraper_type,
        eventType: scraper.event_type,
        manual: true,
      });

      res.json({
        success: true,
        message: `Scraper "${scraper.name}" started`,
        jobId: bullJob.id,
        scraperJobId: jobRow.id,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get active scraper jobs
  app.get('/api/scrapers/active', async (_req: Request, res: Response) => {
    try {
      if (!isQueueAvailable()) {
        return res.json({ success: true, jobs: [] });
      }

      const q = getQueue(projectRoot);
      const [active, waiting] = await Promise.all([
        q.getJobs(['active'], 0, 100),
        q.getJobs(['waiting'], 0, 100),
      ]);
      const allJobs = [...active, ...waiting];
      const scraperJobs = allJobs
        .filter((j: any) => j.name === SCRAPER_RUN)
        .map((job: any) => ({
          id: job.id,
          name: job.name,
          data: job.data,
          status: job.processedOn ? 'active' : 'waiting',
          progress: job.progress,
          attempts: job.attemptsMade,
          createdAt: job.timestamp,
        }));

      res.json({ success: true, jobs: scraperJobs });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Stop a running scraper job
  app.post('/api/scrapers/:jobId/stop', async (req: Request, res: Response) => {
    try {
      if (!isQueueAvailable()) {
        return res.status(503).json({ success: false, error: 'Job queue not available' });
      }

      const q = getQueue(projectRoot);
      try {
        const job = await q.getJob(req.params.jobId);
        if (!job) throw new Error('not found');
        await job.remove();
        res.json({ success: true, message: 'Job stopped' });
      } catch {
        res.status(404).json({ success: false, error: 'Job not found or already completed' });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // SSE stream for scraper logs (requires Redis pub/sub)
  app.get('/api/scrapers/:jobId/stream', async (req: Request, res: Response) => {
    if (!isQueueAvailable()) {
      return res.status(503).json({ success: false, error: 'Streaming not available (Redis not configured)' });
    }

    try {
      const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
      const Redis = require('ioredis').default || require('ioredis');
      const subscriber = new Redis(process.env.REDIS_URL!);
      const channel = `scraper:${req.params.jobId}:logs`;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      await subscriber.subscribe(channel);

      subscriber.on('message', (ch: string, message: string) => {
        if (ch === channel) {
          res.write(`data: ${message}\n\n`);
        }
      });

      req.on('close', () => {
        subscriber.unsubscribe(channel);
        subscriber.quit();
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Create a new scraper
  app.post('/api/scrapers', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('scrapers')
        .insert(req.body)
        .select()
        .single();

      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, scraper: data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Update a scraper
  app.patch('/api/scrapers/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('scrapers')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, scraper: data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Delete a scraper
  app.delete('/api/scrapers/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { error } = await supabase
        .from('scrapers')
        .delete()
        .eq('id', req.params.id);

      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, message: 'Scraper deleted' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
