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

// Defaults target the packages/api module-loader worker (registry queue
// 'jobs', prefix `bull:${BRAND}`). Brands still on the legacy
// scripts/workers/job-worker.js have no scraper:run handler on that queue —
// it's registered on the legacy first worker (queue `jobs-${BRAND}`, default
// `bull` prefix). Such brands override via SCRAPER_QUEUE_NAME /
// SCRAPER_QUEUE_PREFIX until they migrate to the module-loader worker.
const QUEUE_NAME = process.env.SCRAPER_QUEUE_NAME || 'jobs';
const QUEUE_PREFIX = process.env.SCRAPER_QUEUE_PREFIX || `bull:${process.env.BRAND || 'default'}`;

function getQueue(projectRoot: string) {
  if (_queue) return _queue;
  if (!_Queue) {
    const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
    const bullmq = require('bullmq');
    _Queue = bullmq.Queue;
  }
  _queue = new _Queue(QUEUE_NAME, {
    connection: getRedisConnection(),
    prefix: QUEUE_PREFIX,
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

  // ── Refresh a single event from its source ───────────────────────────────
  //
  // Identifies the source (Luma, dev.events, manual) and re-runs the
  // matching extractor for just this event. For Luma, fetches the
  // event_link, parses __NEXT_DATA__ from the HTML, then drives the
  // shared luma-extractor library to upsert hosts, refresh registrant
  // counts (luma_guest_count / luma_ticket_count), and re-extract
  // speakers — same path the LumaICalScraper / LumaSearchScraper take
  // after every page fetch.
  app.post('/api/scrapers/refresh-event', async (req: Request, res: Response) => {
    try {
      const { eventId, eventLink } = (req.body ?? {}) as { eventId?: string; eventLink?: string };
      if (!eventId) {
        return res.status(400).json({ success: false, error: 'eventId required' });
      }

      const supabase = initSupabase(projectRoot);

      // Look up the event row. eventId here is the short slug column.
      const { data: row, error: lookupErr } = await supabase
        .from('events')
        .select('id, event_id, event_title, event_link, event_start, scraped_by, account, source_type, luma_event_id')
        .eq('event_id', eventId)
        .maybeSingle();

      if (lookupErr) {
        return res.status(500).json({ success: false, error: lookupErr.message });
      }
      if (!row) {
        return res.status(404).json({ success: false, error: `Event ${eventId} not found` });
      }

      const link = (eventLink || row.event_link) as string | undefined;
      if (!link) {
        return res.status(400).json({ success: false, error: 'event has no event_link to re-scrape from' });
      }

      const isLuma = /luma\.com\//i.test(link) || (row.scraped_by ?? '').startsWith('Luma');
      if (!isLuma) {
        // For now only Luma is supported — dev.events scraper requires
        // a Puppeteer pipeline that's worker-only. Adding meetup/dev
        // events here would need either a worker dispatch or a
        // synchronous browserless API. Tracked as a follow-up.
        return res.status(400).json({
          success: false,
          error: `Re-scrape currently supports Luma events only. Source detected: ${row.scraped_by ?? 'unknown'}`,
          code: 'UNSUPPORTED_SOURCE',
        });
      }

      // ── 1. Fetch the Luma page ─────────────────────────────────────────
      let html: string;
      try {
        const fetchRes = await fetch(link, {
          headers: {
            // Luma serves __NEXT_DATA__ to plain HTTP requests as long
            // as a recognised user-agent + accept header are set.
            'User-Agent':
              'Mozilla/5.0 (compatible; GatewazeRefresh/1.0; +https://example.com)',
            'Accept': 'text/html,application/xhtml+xml',
          },
        });
        if (!fetchRes.ok) {
          return res.status(502).json({
            success: false,
            error: `Luma page returned ${fetchRes.status} ${fetchRes.statusText}`,
            code: 'UPSTREAM_FETCH_FAILED',
          });
        }
        html = await fetchRes.text();
      } catch (fetchErr: any) {
        return res.status(502).json({
          success: false,
          error: `Failed to fetch ${link}: ${fetchErr.message ?? fetchErr}`,
          code: 'UPSTREAM_FETCH_FAILED',
        });
      }

      // ── 2. Parse __NEXT_DATA__ ────────────────────────────────────────
      const match = html.match(
        /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
      );
      if (!match) {
        return res.status(502).json({
          success: false,
          error: 'Luma page did not contain __NEXT_DATA__ — page structure may have changed',
          code: 'NEXT_DATA_MISSING',
        });
      }

      let nextData: any;
      try {
        nextData = JSON.parse(match[1]);
      } catch (parseErr: any) {
        return res.status(502).json({
          success: false,
          error: `Failed to parse __NEXT_DATA__: ${parseErr.message}`,
          code: 'NEXT_DATA_INVALID',
        });
      }

      // Strip personal data per the same convention as the scraper —
      // keep pageProps which has event metadata, drop initialUserData.
      const lumaPageData = nextData?.props?.pageProps
        ? {
            buildId: nextData.buildId,
            pageProps: { ...nextData.props.pageProps },
          }
        : null;
      if (!lumaPageData) {
        return res.status(502).json({
          success: false,
          error: 'Luma page __NEXT_DATA__ missing pageProps — cannot extract',
          code: 'NEXT_DATA_INVALID',
        });
      }

      // ── 3. Drive the shared luma-extractor ────────────────────────────
      // Sibling-relative — api.ts and scripts/lib/ live under the same
      // module root no matter where the module is mounted.
      const extractor: any = await import('./scripts/lib/luma-extractor.js');
      const {
        extractHostsFromLumaData,
        extractLumaCountsFromLumaData,
        extractSpeakersFromHtml,
        upsertHosts,
        upsertSpeakers,
      } = extractor;

      const hosts = extractHostsFromLumaData(lumaPageData) || [];
      const counts = extractLumaCountsFromLumaData(lumaPageData) || { guest_count: null, ticket_count: null };

      // Pull the description HTML for speaker extraction. Luma stores it
      // in pageProps.initialData.data.event.description_html (or .description).
      const eventBlock =
        lumaPageData?.pageProps?.initialData?.data?.event ??
        lumaPageData?.pageProps?.data?.event ?? {};
      const descriptionHtml: string | null =
        eventBlock?.description_html ?? eventBlock?.description ?? null;
      const lumaEventIdNew: string | null = eventBlock?.api_id ?? row.luma_event_id ?? null;

      // ── 4. Update the events row with refreshed data ──────────────────
      const updates: Record<string, unknown> = {
        luma_page_data: lumaPageData,
        luma_guest_count: counts.guest_count,
        luma_ticket_count: counts.ticket_count,
        luma_counts_updated_at: new Date().toISOString(),
        last_scraped_at: new Date().toISOString(),
      };
      if (lumaEventIdNew && !row.luma_event_id) updates.luma_event_id = lumaEventIdNew;

      const { error: updateErr } = await supabase
        .from('events')
        .update(updates)
        .eq('id', row.id);
      if (updateErr) {
        return res
          .status(500)
          .json({ success: false, error: `Update failed: ${updateErr.message}` });
      }

      // ── 5. Upsert hosts via the shared library ────────────────────────
      const eventContext = {
        sourceEventId: lumaEventIdNew || row.luma_event_id || row.event_id,
        gatewazeEventId: row.id,
        eventTitle: row.event_title,
        eventUrl: link,
        eventStartAt: row.event_start,
        calendarName: row.account || null,
        guestCount: counts.guest_count ?? null,
      };

      let hostStats = { inserted: 0, linked: 0 };
      if (hosts.length > 0) {
        try {
          hostStats = await upsertHosts(supabase, hosts, eventContext);
        } catch (hostErr: any) {
          console.warn('Host upsert failed:', hostErr?.message ?? hostErr);
        }
      }

      // ── 6. Speakers (best-effort; AI extraction can fail) ─────────────
      let speakerStats: { inserted?: number; linked?: number; skipped?: string } = {};
      if (descriptionHtml) {
        try {
          const speakers = await extractSpeakersFromHtml(descriptionHtml, row.event_title);
          if (speakers && speakers.length > 0) {
            speakerStats = await upsertSpeakers(supabase, speakers, eventContext);
          }
        } catch (speakerErr: any) {
          console.warn('Speaker extraction failed:', speakerErr?.message ?? speakerErr);
        }
      }

      return res.json({
        success: true,
        eventId: row.event_id,
        guestCount: counts.guest_count,
        ticketCount: counts.ticket_count,
        hosts: hostStats,
        speakers: speakerStats,
      });
    } catch (err: any) {
      console.error('refresh-event failed:', err);
      return res
        .status(500)
        .json({ success: false, error: err?.message ?? String(err) });
    }
  });

  // Slow vs Fast variant comparison.
  // See spec-scrapling-fetcher-service.md §4.6.
  app.get('/api/scrapers/comparison', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const windowDaysRaw = Number(req.query.window_days ?? 7);
      const windowDays = Number.isFinite(windowDaysRaw)
        ? Math.max(1, Math.min(90, windowDaysRaw))
        : 7;
      const { data, error } = await supabase.rpc('scrapers_compare_variants', {
        p_window_days: windowDays,
      });
      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
      res.json({ success: true, window_days: windowDays, pairs: data ?? [] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  });

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

  // Get scraper job logs (historical log entries for a specific job run)
  app.get('/api/scrapers/:jobId/logs', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const jobId = parseInt(req.params.jobId, 10);

      const { data: logs, error } = await supabase
        .from('scrapers_job_logs')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at', { ascending: true })
        .limit(500);

      if (error) {
        // Fall back to empty if table doesn't exist yet
        if (error.code === 'PGRST205' || error.code === '42P01') {
          return res.json([]);
        }
        return res.status(500).json({ success: false, error: error.message });
      }

      // Transform DB rows to LogEntry format expected by the modal
      const entries = (logs || []).map((row: any) => ({
        type: row.log_type || 'log',
        message: row.message,
        timestamp: row.created_at,
        level: row.log_level || 'info',
        metadata: row.metadata,
      }));

      res.json(entries);
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

  // Remove any BullMQ jobs whose data.scraperJobId matches any of the given DB
  // job IDs. Active jobs are LOCKED by the worker running them (Chromium-backed
  // scrape in flight) and BullMQ's job.remove() will silently no-op on those.
  // So we force-remove by deleting the job's Redis keys and list entries
  // directly when the library path fails — the worker will then error out
  // cleanly when it tries to finalise the orphaned job, handled by the
  // "Job not found in database" skipRetry path in scraper-job-handler.js.
  async function removeBullJobsForDbIds(dbJobIds: Array<string | number>): Promise<{ removed: number; forced: number; errors: string[] }> {
    const errors: string[] = [];
    let removed = 0;
    let forced = 0;
    if (!isQueueAvailable() || dbJobIds.length === 0) return { removed, forced, errors };

    try {
      const q = getQueue(projectRoot);
      const jobs = await q.getJobs(['active', 'waiting', 'delayed', 'paused'], 0, 1000);
      const idSet = new Set(dbJobIds.map((id) => Number(id)));

      // Shared Redis client for force-remove fallback. BullMQ exposes the
      // underlying ioredis client via `queue.client` (a Promise in v5+).
      const redis: any = await (q as any).client;
      const prefix = ((q as any).opts?.prefix) || 'bull';
      const queueName = q.name;

      for (const bullJob of jobs) {
        const scraperJobId = Number((bullJob as any)?.data?.scraperJobId);
        if (!idSet.has(scraperJobId)) continue;

        // Try the library path first — cleanest state transition when the job
        // isn't locked. Succeeds for waiting/delayed/paused jobs.
        let removedViaLib = false;
        try {
          await bullJob.remove();
          removedViaLib = true;
          removed++;
        } catch { /* will force-remove below */ }

        if (removedViaLib) continue;

        // Force-remove: delete the job hash, release the lock, and LREM from
        // every state list. The worker currently holding the lock will throw
        // when it next tries to touch the job; its error path falls back to
        // "Job not found in database — skipping".
        try {
          const jobKey = `${prefix}:${queueName}:${bullJob.id}`;
          await redis.del(jobKey, `${jobKey}:lock`);
          await redis.lrem(`${prefix}:${queueName}:active`, 0, String(bullJob.id));
          await redis.lrem(`${prefix}:${queueName}:wait`, 0, String(bullJob.id));
          await redis.lrem(`${prefix}:${queueName}:delayed`, 0, String(bullJob.id));
          await redis.lrem(`${prefix}:${queueName}:paused`, 0, String(bullJob.id));
          await redis.srem(`${prefix}:${queueName}:stalled`, String(bullJob.id));
          forced++;
        } catch (e: any) {
          errors.push(`force-remove ${bullJob.id}: ${e.message}`);
        }
      }
    } catch (e: any) {
      errors.push(`queue scan failed: ${e.message}`);
    }
    return { removed, forced, errors };
  }

  // Delete a scraper job — DB row + any matching BullMQ/Redis entries.
  app.delete('/api/scrapers/jobs/:jobId', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const jobId = Number(req.params.jobId);
      if (!Number.isFinite(jobId)) return res.status(400).json({ success: false, error: 'Invalid jobId' });

      const bull = await removeBullJobsForDbIds([jobId]);

      const { error: logsErr } = await supabase.from('scrapers_job_logs').delete().eq('job_id', jobId);
      if (logsErr) return res.status(500).json({ success: false, error: `logs: ${logsErr.message}` });
      const { error } = await supabase.from('scrapers_jobs').delete().eq('id', jobId);
      if (error) return res.status(500).json({ success: false, error: error.message });

      res.json({ success: true, bullRemoved: bull.removed, bullForceRemoved: bull.forced, bullErrors: bull.errors });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Bulk delete — accepts { ids: number[] } or { status: 'pending' }.
  app.post('/api/scrapers/jobs/bulk-delete', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { ids, status } = req.body || {};

      let targetIds: number[] = [];
      if (Array.isArray(ids) && ids.length > 0) {
        targetIds = ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n));
      } else if (status) {
        const { data, error } = await supabase.from('scrapers_jobs').select('id').eq('status', status);
        if (error) return res.status(500).json({ success: false, error: error.message });
        targetIds = (data || []).map((r: any) => Number(r.id));
      } else {
        return res.status(400).json({ success: false, error: 'Provide either ids or status' });
      }

      if (targetIds.length === 0) return res.json({ success: true, deleted: 0, bullRemoved: 0 });

      const bull = await removeBullJobsForDbIds(targetIds);

      const { error: logsErr } = await supabase.from('scrapers_job_logs').delete().in('job_id', targetIds);
      if (logsErr) return res.status(500).json({ success: false, error: `logs: ${logsErr.message}` });
      const { error, count } = await supabase
        .from('scrapers_jobs')
        .delete({ count: 'exact' })
        .in('id', targetIds);
      if (error) return res.status(500).json({ success: false, error: error.message });

      res.json({ success: true, deleted: count || 0, bullRemoved: bull.removed, bullForceRemoved: bull.forced, bullErrors: bull.errors });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // SSE stream for scraper logs (requires Redis pub/sub)
  app.get('/api/scrapers/:jobId/stream', async (req: Request, res: Response) => {
    if (!isQueueAvailable()) {
      return res.status(503).json({ success: false, error: 'Streaming not available (Redis not configured)' });
    }

    const channel = `scraper:${req.params.jobId}:logs`;

    try {
      const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
      const Redis = require('ioredis').default || require('ioredis');
      const subscriber = new Redis(getRedisConnection());

      // Wait for Redis connection before sending headers
      await new Promise<void>((resolve, reject) => {
        subscriber.on('ready', resolve);
        subscriber.on('error', reject);
        // Timeout after 5s
        setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
      });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send initial connected event
      res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

      await subscriber.subscribe(channel);
      console.log(`[scrapers] SSE stream connected for channel: ${channel}`);

      subscriber.on('message', (ch: string, message: string) => {
        if (ch === channel) {
          res.write(`data: ${message}\n\n`);
        }
      });

      // Keepalive every 15s to prevent proxy timeouts
      const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { /* client disconnected */ }
      }, 15000);

      req.on('close', () => {
        clearInterval(keepalive);
        subscriber.unsubscribe(channel);
        subscriber.quit();
        console.log(`[scrapers] SSE stream disconnected for channel: ${channel}`);
      });
    } catch (error: any) {
      console.error(`[scrapers] SSE stream error for ${channel}:`, error.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message });
      }
    }
  });

  // Create a new scraper
  //
  // Calendars used to be eagerly materialised here for LumaICalScraper
  // creates, mirroring the auto-discovery path. That left empty calendar
  // shells behind whenever a scraper never produced events. Calendars are
  // now created lazily on first event in scraper-job-handler.js, so this
  // handler just persists the scraper row.
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
      const scraperId = Number(req.params.id);
      if (!Number.isFinite(scraperId)) {
        return res.status(400).json({ success: false, error: 'Invalid scraper id' });
      }

      // First, find every scraper_job row for this scraper and evict any matching
      // BullMQ entries. Without this, active/queued BullMQ jobs outlive the DB
      // row and the worker spins on "Job not found in database".
      const { data: jobs } = await supabase
        .from('scrapers_jobs')
        .select('id')
        .eq('scraper_id', scraperId);
      const jobIds = (jobs || []).map((j: any) => Number(j.id)).filter(Number.isFinite);
      const bull = jobIds.length > 0
        ? await removeBullJobsForDbIds(jobIds)
        : { removed: 0, forced: 0, errors: [] };

      // Logs → jobs → scraper. The DB has ON DELETE CASCADE on the jobs FK,
      // but log rows reference jobs by id without a cascade, so clear them first.
      if (jobIds.length > 0) {
        await supabase.from('scrapers_job_logs').delete().in('job_id', jobIds);
      }
      const { error } = await supabase.from('scrapers').delete().eq('id', scraperId);
      if (error) return res.status(500).json({ success: false, error: error.message });

      res.json({
        success: true,
        message: 'Scraper deleted',
        jobsDeleted: jobIds.length,
        bullRemoved: bull.removed,
        bullForceRemoved: bull.forced,
        bullErrors: bull.errors,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Health summary for admin dashboard
  app.get('/api/scrapers/health', async (_req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase.rpc('scrapers_health_summary');

      if (error) return res.status(500).json({ success: false, error: error.message });

      // Get scheduler health from Redis
      let schedulerLastRun: string | null = null;
      if (isQueueAvailable()) {
        try {
          const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
          const Redis = require('ioredis');
          const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', { maxRetriesPerRequest: 1 });
          schedulerLastRun = await redis.get('scheduler:last_run');
          await redis.quit();
        } catch { /* non-fatal */ }
      }

      const health = data?.[0] || data || {};
      res.json({
        success: true,
        health: {
          ...health,
          scheduler_last_run: schedulerLastRun ? parseInt(schedulerLastRun) : null,
          scheduler_healthy: schedulerLastRun ? (Date.now() - parseInt(schedulerLastRun)) < 3 * 60 * 1000 : null,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Retry a failed job
  app.post('/api/scrapers/:jobId/retry', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const originalJobId = req.params.jobId;

      // Get original job details
      const { data: originalJob, error: fetchError } = await supabase
        .rpc('scrapers_get_job', { job_id: originalJobId });

      if (fetchError || !originalJob || originalJob.length === 0) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      const job = originalJob[0];

      // Create a new job record with retry_of reference
      const { data: newJobData, error: createError } = await supabase
        .rpc('scrapers_create_job', {
          scraper_ids: [job.scraper_id],
          created_by_name: 'admin-retry',
        });

      if (createError) return res.status(500).json({ success: false, error: createError.message });

      const newJobId = newJobData?.[0]?.id || newJobData?.[0];
      if (!newJobId) return res.status(500).json({ success: false, error: 'Failed to create retry job' });

      // Set retry_of on the new job
      await supabase
        .from('scrapers_jobs')
        .update({ retry_of: originalJobId })
        .eq('id', newJobId);

      // Enqueue to BullMQ
      if (isQueueAvailable()) {
        await addJob(projectRoot, SCRAPER_RUN, {
          scraperJobId: newJobId,
          scraperId: job.scraper_id,
          scraperName: job.scraper_name,
          scraperType: job.scraper_type,
          eventType: job.event_type,
          manual: true,
        });
      }

      res.json({ success: true, jobId: newJobId, retryOf: originalJobId });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ===========================================================================
  // Event Hosts — outreach pipeline for event organizers discovered by scrapers
  // ===========================================================================

  // List hosts with event counts
  // Hosts attached to a specific event (for the Event details Hosts tab).
  // Accepts either the 6-char event_id code (from the URL) or the UUID.
  // event_host_events has no `id` column — (host_id, source_event_id) is the PK.
  app.get('/api/events/:eventId/hosts', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const raw = req.params.eventId;
      const isUuid = /^[0-9a-f-]{36}$/i.test(raw);

      let eventUuid = raw;
      if (!isUuid) {
        const { data: ev } = await supabase
          .from('events')
          .select('id')
          .eq('event_id', raw)
          .maybeSingle();
        if (!ev) return res.json({ success: true, hosts: [] });
        eventUuid = ev.id;
      }

      const { data, error } = await supabase
        .from('event_host_events')
        .select(`
          host_id, source_event_id, host_position, guest_count, role, event_start_at,
          host:event_hosts!inner (
            id, name, email, avatar_url, luma_user_id, luma_profile_url,
            linkedin_url, outreach_status, bio, company, job_title
          )
        `)
        .eq('gatewaze_event_id', eventUuid)
        .order('host_position', { ascending: true, nullsFirst: false });

      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, hosts: data || [] });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Leaderboard — hosts ranked by weighted guest-count score. Backs the
  // "League Table" tab on the Event Hosts admin page.
  app.get('/api/scrapers/hosts/leaderboard', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const statusFilter = (req.query.status as string) || null;
      const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500);
      const fromIso = (req.query.from as string) || null;
      const toIso = (req.query.to as string) || null;

      // When a date range is specified (or `range` preset), call the
      // function form so events outside the window don't contribute to the
      // weighted score. NULL bounds = full all-time view.
      const { data: rpcData, error: rpcErr } = await supabase.rpc('event_hosts_leaderboard_fn', {
        p_from: fromIso,
        p_to: toIso,
      });
      if (rpcErr) return res.status(500).json({ success: false, error: rpcErr.message });

      let rows = (rpcData || []) as any[];

      if (statusFilter) {
        const statuses = statusFilter.split(',').map((s) => s.trim()).filter(Boolean);
        const set = new Set(statuses);
        rows = rows.filter((r) => set.has(r.outreach_status));
      }
      rows.sort((a, b) => (b.weighted_score ?? 0) - (a.weighted_score ?? 0));
      rows = rows.slice(0, limit);

      res.json({ success: true, hosts: rows });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // City rollup — city/status counts + top hosts per city for the Map tab.
  // Only returns cities; hosts inside each city are resolved on click.
  app.get('/api/scrapers/hosts/cities', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const statusFilter = (req.query.status as string) || null;

      let query = supabase.from('event_hosts_by_city').select('*');
      if (statusFilter) {
        const statuses = statusFilter.split(',').map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) query = query.eq('outreach_status', statuses[0]);
        else if (statuses.length > 1) query = query.in('outreach_status', statuses);
      }

      const { data, error } = await query;
      if (error) return res.status(500).json({ success: false, error: error.message });

      // Aggregate per-city regardless of status so the marker reflects the
      // filtered totals (e.g. "5 ready-to-talk hosts in SF"). Keep the raw
      // breakdown too, so the popup can show "3 new, 2 ready".
      const byCity = new Map<string, any>();
      for (const row of (data || []) as any[]) {
        const key = row.city;
        if (!byCity.has(key)) {
          byCity.set(key, {
            city: row.city,
            country_code: row.country_code,
            host_count: 0,
            total_events: 0,
            total_weighted_score: 0,
            by_status: {} as Record<string, number>,
          });
        }
        const agg = byCity.get(key)!;
        agg.host_count += row.host_count || 0;
        agg.total_events += row.total_events || 0;
        agg.total_weighted_score += row.total_weighted_score || 0;
        agg.by_status[row.outreach_status] = (agg.by_status[row.outreach_status] || 0) + (row.host_count || 0);
      }
      res.json({ success: true, cities: Array.from(byCity.values()) });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Map data — cities with coords + host/status breakdown + top hosts each.
  // Coords are averaged from the events that hosts are linked to (via
  // event_host_events.gatewaze_event_id → events.event_location). Only
  // returns cities where at least one event has a parseable "lat,lng" string.
  app.get('/api/scrapers/hosts/map', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const statusFilter = (req.query.status as string) || null;
      const minEvents = Math.max(1, parseInt((req.query.min_events as string) || '1', 10));
      const topN = Math.min(parseInt((req.query.top as string) || '5', 10), 10);

      // Pull leaderboard entries with a primary_city
      let lbQuery = supabase.from('event_hosts_leaderboard').select('*').not('primary_city', 'is', null);
      if (statusFilter) {
        const statuses = statusFilter.split(',').map((s) => s.trim()).filter(Boolean);
        if (statuses.length >= 1) lbQuery = lbQuery.in('outreach_status', statuses);
      }
      const { data: hostsData, error: lbErr } = await lbQuery;
      if (lbErr) return res.status(500).json({ success: false, error: lbErr.message });
      const hosts = (hostsData || []) as any[];

      // Coords lookup: pick one representative event per city (first with a
      // parseable location). We'd ideally average, but for map markers a
      // single-point-per-city is fine and much cheaper.
      const cities = Array.from(new Set(hosts.map((h) => h.primary_city).filter(Boolean)));
      let cityCoords: Record<string, { lat: number; lng: number; country_code: string | null }> = {};
      if (cities.length > 0) {
        const { data: eventRows } = await supabase
          .from('events')
          .select('event_city, event_country_code, event_location')
          .in('event_city', cities)
          .not('event_location', 'is', null);
        for (const row of (eventRows || []) as any[]) {
          const city = row.event_city;
          if (!city || cityCoords[city]) continue;
          const parts = String(row.event_location || '').split(',').map((p) => Number(p.trim()));
          if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
            cityCoords[city] = { lat: parts[0], lng: parts[1], country_code: row.event_country_code || null };
          }
        }
      }

      // Group hosts by city, compute top N
      const groupedByCity = new Map<string, any[]>();
      for (const h of hosts) {
        if (!groupedByCity.has(h.primary_city)) groupedByCity.set(h.primary_city, []);
        groupedByCity.get(h.primary_city)!.push(h);
      }

      const markers = [] as any[];
      for (const [city, cityHosts] of groupedByCity.entries()) {
        const coords = cityCoords[city];
        if (!coords) continue; // no coords, skip
        const sorted = cityHosts.sort((a, b) => (b.weighted_score || 0) - (a.weighted_score || 0));
        const activeHosts = sorted.filter((h) => (h.events_count || 0) >= minEvents);
        if (activeHosts.length === 0) continue;

        const byStatus: Record<string, number> = {};
        for (const h of activeHosts) {
          byStatus[h.outreach_status] = (byStatus[h.outreach_status] || 0) + 1;
        }

        markers.push({
          city,
          country_code: coords.country_code,
          lat: coords.lat,
          lng: coords.lng,
          host_count: activeHosts.length,
          by_status: byStatus,
          top_hosts: activeHosts.slice(0, topN).map((h) => ({
            host_id: h.host_id,
            name: h.name,
            avatar_url: h.avatar_url,
            weighted_score: h.weighted_score,
            events_count: h.events_count,
            outreach_status: h.outreach_status,
          })),
        });
      }

      res.json({ success: true, markers });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Top hosts for a specific city — used by the map popup.
  app.get('/api/scrapers/hosts/cities/:city/top', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const statusFilter = (req.query.status as string) || null;
      const limit = Math.min(parseInt((req.query.limit as string) || '5', 10), 20);

      let query = supabase
        .from('event_hosts_leaderboard')
        .select('*')
        .eq('primary_city', req.params.city)
        .order('weighted_score', { ascending: false, nullsFirst: false })
        .limit(limit);

      if (statusFilter) {
        const statuses = statusFilter.split(',').map((s) => s.trim()).filter(Boolean);
        if (statuses.length >= 1) query = query.in('outreach_status', statuses);
      }

      const { data, error } = await query;
      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, hosts: data || [] });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/scrapers/hosts', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const search = (req.query.search as string) || null;
      const status = (req.query.status as string) || null;
      const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500);
      const offset = parseInt((req.query.offset as string) || '0', 10);
      const includeCompanies = req.query.include_companies === '1' || req.query.include_companies === 'true';

      const { data, error } = await supabase.rpc('event_hosts_with_event_count', {
        p_search: search,
        p_status: status,
        p_limit: limit,
        p_offset: offset,
        p_include_companies: includeCompanies,
      });

      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, hosts: data || [] });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get a single host + its events
  app.get('/api/scrapers/hosts/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data: host, error } = await supabase
        .from('event_hosts')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (error || !host) {
        return res.status(404).json({ success: false, error: 'Host not found' });
      }

      const { data: events } = await supabase.rpc('event_hosts_events_for_host', {
        p_host_id: req.params.id,
      });

      res.json({ success: true, host, events: events || [] });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Update a host (status, notes, LinkedIn URL, etc.)
  app.patch('/api/scrapers/hosts/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const allowedFields = [
        'outreach_status',
        'outreach_notes',
        'contacted_at',
        'email',
        'linkedin_url',
        'twitter_url',
        'website_url',
        'company',
        'job_title',
      ];
      const updates: Record<string, unknown> = {};
      for (const f of allowedFields) {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
      }
      // Auto-stamp contacted_at when the status flips to 'contacted' and it wasn't set
      if (req.body.outreach_status === 'contacted' && !req.body.contacted_at) {
        updates.contacted_at = new Date().toISOString();
      }
      updates.last_activity_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('event_hosts')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, host: data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // CSV export of hosts (filtered by status / search)
  app.get('/api/scrapers/hosts/export.csv', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const search = (req.query.search as string) || null;
      const status = (req.query.status as string) || null;

      const { data, error } = await supabase.rpc('event_hosts_with_event_count', {
        p_search: search,
        p_status: status,
        p_limit: 10000,
        p_offset: 0,
      });
      if (error) return res.status(500).json({ success: false, error: error.message });

      const rows = data || [];
      const headers = [
        'name', 'email', 'company', 'job_title',
        'linkedin_url', 'twitter_url', 'website_url', 'luma_profile_url',
        'event_count', 'latest_event_at', 'latest_event_title',
        'outreach_status', 'outreach_notes', 'contacted_at',
      ];
      const escape = (v: unknown) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };
      const csv = [
        headers.join(','),
        ...rows.map((r: Record<string, unknown>) => headers.map((h) => escape(r[h])).join(',')),
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="event-hosts-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
