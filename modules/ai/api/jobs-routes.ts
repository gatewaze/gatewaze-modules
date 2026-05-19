/**
 * /admin/jobs/* + per-run/thread SSE endpoints.
 *
 * Mounted under /api/modules/ai by register-routes.ts.
 *
 * Endpoint catalogue (per spec-ai-job-runner §5.2):
 *   GET    /admin/jobs                    — list + filter
 *   GET    /admin/jobs/:id                — single inspect
 *   POST   /admin/jobs/:id/stop           — cancel + remove
 *   POST   /admin/jobs/:id/retry          — retry failed
 *   POST   /admin/jobs/:id/promote        — promote delayed
 *   GET    /admin/jobs/:id/stream         — SSE replay-from-offset
 *   GET    /admin/recipe-runs/:id/stream  — alias by run id (convenience)
 *   GET    /admin/threads/:id/stream      — chat thread SSE
 */

import type { Request, Response, Router } from 'express';

import { broadcastCancel } from '../lib/jobs/cancel.js';
import {
  getJob,
  getJobsQueue,
  listJobs,
} from '../lib/jobs/inspector.js';
import { pingRedis } from '../lib/jobs/redis-client.js';
import { forwardStreamToSse } from '../lib/jobs/stream-bridge.js';
import {
  messageCancelChannel,
  recipeRunCancelChannel,
  recipeRunStreamKey,
  threadStreamKey,
} from '../lib/jobs/stream-keys.js';
import {
  JobIdParamSchema,
  ListJobsQuerySchema,
  StreamOffsetQuerySchema,
  UuidParamSchema,
  parseQuery,
  parseStatusList,
} from './jobs-schemas.js';

// Process-local SSE counter for the §8.4 connection-pool cap.
const SSE_POOL_MAX = Number(process.env.AI_SSE_POOL_MAX ?? 256);
let activeSseCount = 0;

// Input shape validation moved to jobs-schemas.ts (zod).

interface JobsRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  /** Required so the inspector can resolve the `jobs-${BRAND}` queue. */
  projectRoot?: string;
  /** Required for operator-explicit retries that create a new run row. */
  enqueueJob?: (
    queue: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ id: string | undefined }>;
}

export function mountJobsRoutes(router: Router, deps: JobsRoutesDeps): void {
  const sendError = (res: Response, status: number, code: string, message: string) =>
    res.status(status).json({ error: { code, message } });

  // ── GET /admin/jobs ─────────────────────────────────────────────────
  router.get('/admin/jobs', async (req: Request, res: Response) => {
    const q = parseQuery(ListJobsQuerySchema, req.query);
    if (!q.ok) return sendError(res, 400, q.code, q.message);
    if (!deps.projectRoot) return sendError(res, 503, 'projectRoot_missing', 'jobs inspector needs projectRoot');
    if (!(await pingRedis())) return sendError(res, 503, 'redis_unavailable', 'Redis is required');
    const states = parseStatusList(q.value.status);
    const limit = q.value.limit ?? 100;
    const offset = q.value.offset ?? 0;
    const filterType = q.value.type ?? 'ai:';
    const prefix = filterType === 'all' ? undefined : filterType.endsWith('*') ? filterType.slice(0, -1) : filterType;
    try {
      const queue = await getJobsQueue({ projectRoot: deps.projectRoot });
      const result = await listJobs(queue, {
        states,
        limit,
        offset,
        ...(prefix ? { prefix } : {}),
      });
      res.status(200).json(result);
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ── GET /admin/jobs/:id ─────────────────────────────────────────────
  router.get('/admin/jobs/:id', async (req: Request, res: Response) => {
    const idP = JobIdParamSchema.safeParse(req.params);
    if (!idP.success) return sendError(res, 400, 'invalid_id', idP.error.issues[0]?.message ?? 'bad id');
    const id = idP.data.id;
    if (!deps.projectRoot) return sendError(res, 503, 'projectRoot_missing', 'projectRoot required');
    try {
      const queue = await getJobsQueue({ projectRoot: deps.projectRoot });
      const dto = await getJob(queue, id);
      if (!dto) return sendError(res, 404, 'job_not_found', `no job '${id}'`);
      res.status(200).json(dto);
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ── POST /admin/jobs/:id/stop ───────────────────────────────────────
  router.post('/admin/jobs/:id/stop', async (req: Request, res: Response) => {
    const idP = JobIdParamSchema.safeParse(req.params);
    if (!idP.success) return sendError(res, 400, 'invalid_id', idP.error.issues[0]?.message ?? 'bad id');
    const id = idP.data.id;
    if (!deps.projectRoot) return sendError(res, 503, 'projectRoot_missing', 'projectRoot required');
    try {
      const queue = await getJobsQueue({ projectRoot: deps.projectRoot });
      const dto = await getJob(queue, id);
      if (!dto) return sendError(res, 404, 'job_not_found', `no job '${id}'`);
      if (dto.owner_module !== 'ai') {
        return sendError(res, 403, 'wrong_module', `job belongs to '${dto.owner_module}' — stop via that module's surface`);
      }
      if (['completed', 'failed'].includes(dto.status)) {
        return sendError(res, 409, 'job_terminal', `job is ${dto.status}`);
      }
      // 1. PUBLISH cancel for the worker's pub/sub subscriber.
      if (dto.linked_row?.table === 'ai_recipe_runs') {
        await broadcastCancel(recipeRunCancelChannel(dto.linked_row.id), 'admin');
        await deps.supabase
          .from('ai_recipe_runs')
          .update({ status: 'cancelling', cancel_requested_at: new Date().toISOString() })
          .eq('id', dto.linked_row.id)
          .in('status', ['queued', 'running']);
      } else if (dto.linked_row?.table === 'ai_messages') {
        await broadcastCancel(messageCancelChannel(dto.linked_row.id), 'admin');
        await deps.supabase
          .from('ai_messages')
          .update({ status: 'cancelling', cancel_requested_at: new Date().toISOString() })
          .eq('id', dto.linked_row.id)
          .in('status', ['queued', 'running']);
      }
      // 2. Best-effort BullMQ remove — silent no-op on active jobs.
      try {
        const j = await queue.getJob(id);
        if (j) await j.remove();
      } catch {
        // Active job locked by worker. Pub/sub + DB poll handles it.
      }
      res.status(204).end();
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ── POST /admin/jobs/:id/retry ──────────────────────────────────────
  //
  // spec-ai-job-runner §4.4 — operator-explicit retry creates a NEW
  // ai_recipe_runs row with retry_of_run_id set to the original. The
  // original failed row is preserved for audit. A fresh BullMQ job is
  // enqueued (NOT BullMQ's own job.retry(), which would re-use the
  // same job ID and stream key).
  //
  // For ai:run-chat jobs the chat row is single-use; we don't auto-
  // create a new turn — those retries are rejected with 409.
  router.post('/admin/jobs/:id/retry', async (req: Request, res: Response) => {
    const idP = JobIdParamSchema.safeParse(req.params);
    if (!idP.success) return sendError(res, 400, 'invalid_id', idP.error.issues[0]?.message ?? 'bad id');
    const id = idP.data.id;
    if (!deps.projectRoot) return sendError(res, 503, 'projectRoot_missing', 'projectRoot required');
    if (!deps.enqueueJob) return sendError(res, 503, 'enqueue_unavailable', 'enqueueJob not wired');
    try {
      const queue = await getJobsQueue({ projectRoot: deps.projectRoot });
      const dto = await getJob(queue, id);
      if (!dto) return sendError(res, 404, 'job_not_found', `no job '${id}'`);
      if (dto.owner_module !== 'ai') return sendError(res, 403, 'wrong_module', `not an ai job`);
      if (dto.status !== 'failed') return sendError(res, 409, 'not_failed', `job is ${dto.status}`);
      if (dto.name !== 'ai:run-recipe') {
        return sendError(res, 409, 'retry_unsupported', `retry is only supported for ai:run-recipe (got ${dto.name})`);
      }
      const originalRunId = dto.linked_row?.id;
      if (!originalRunId) {
        return sendError(res, 409, 'retry_unsupported', 'job has no linked recipe run row');
      }
      // Read the original row + clone everything except status/steps.
      const orig = await deps.supabase
        .from('ai_recipe_runs')
        .select('recipe_id, recipe_file_path, recipe_content_hash, user_id, use_case, host_kind, host_id, params, recipe_snapshot, sub_recipes_snapshot')
        .eq('id', originalRunId)
        .maybeSingle();
      if (orig.error || !orig.data) {
        return sendError(res, 404, 'run_row_not_found', `original run '${originalRunId}' not found`);
      }
      const ins = await deps.supabase
        .from('ai_recipe_runs')
        .insert({
          ...orig.data,
          status: 'queued',
          steps: [],
          retry_of_run_id: originalRunId,
        })
        .select('id')
        .maybeSingle();
      if (ins.error || !ins.data) {
        return sendError(res, 500, 'internal_error', ins.error?.message ?? 'insert failed');
      }
      const newRunId = ins.data.id as string;
      const r = await deps.enqueueJob('jobs', 'ai:run-recipe', {
        runId: newRunId,
        useCase: orig.data.use_case,
        recipeId: orig.data.recipe_id,
        userId: orig.data.user_id,
      });
      await deps.supabase
        .from('ai_recipe_runs')
        .update({ bull_job_id: r.id ?? null })
        .eq('id', newRunId);
      res.status(201).json({
        new_run_id: newRunId,
        retry_of_run_id: originalRunId,
        job_id: r.id,
        stream_url: `/api/modules/ai/admin/recipe-runs/${newRunId}/stream`,
      });
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ── POST /admin/jobs/:id/promote ────────────────────────────────────
  router.post('/admin/jobs/:id/promote', async (req: Request, res: Response) => {
    const idP = JobIdParamSchema.safeParse(req.params);
    if (!idP.success) return sendError(res, 400, 'invalid_id', idP.error.issues[0]?.message ?? 'bad id');
    const id = idP.data.id;
    if (!deps.projectRoot) return sendError(res, 503, 'projectRoot_missing', 'projectRoot required');
    try {
      const queue = await getJobsQueue({ projectRoot: deps.projectRoot });
      const dto = await getJob(queue, id);
      if (!dto) return sendError(res, 404, 'job_not_found', `no job '${id}'`);
      if (dto.owner_module !== 'ai') return sendError(res, 403, 'wrong_module', `not an ai job`);
      if (dto.status !== 'delayed') return sendError(res, 409, 'not_delayed', `job is ${dto.status}`);
      const j = await queue.getJob(id);
      if (!j) return sendError(res, 404, 'job_not_found', `no job '${id}'`);
      await j.promote();
      res.status(204).end();
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ── GET /admin/jobs/:id/stream ──────────────────────────────────────
  router.get('/admin/jobs/:id/stream', async (req: Request, res: Response) => {
    const idP = JobIdParamSchema.safeParse(req.params);
    if (!idP.success) return sendError(res, 400, 'invalid_id', idP.error.issues[0]?.message ?? 'bad id');
    const id = idP.data.id;
    if (!deps.projectRoot) return sendError(res, 503, 'projectRoot_missing', 'projectRoot required');
    try {
      const queue = await getJobsQueue({ projectRoot: deps.projectRoot });
      const dto = await getJob(queue, id);
      if (!dto || !dto.stream_key) return sendError(res, 404, 'job_not_found', `no streamable job '${id}'`);
      await pipeSse(req, res, dto.stream_key);
    } catch (err) {
      // SSE may have already started — ignore errors after headers are out.
      if (!res.headersSent) sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ── GET /admin/recipe-runs/:id/stream — convenience alias by runId ──
  router.get('/admin/recipe-runs/:id/stream', async (req: Request, res: Response) => {
    const idP = UuidParamSchema.safeParse(req.params);
    if (!idP.success) return sendError(res, 400, 'invalid_id', idP.error.issues[0]?.message ?? 'bad id');
    const id = idP.data.id;
    await pipeSse(req, res, recipeRunStreamKey(id));
  });

  // ── GET /admin/threads/:id/stream — chat thread SSE ────────────────
  router.get('/admin/threads/:id/stream', async (req: Request, res: Response) => {
    const idP = UuidParamSchema.safeParse(req.params);
    if (!idP.success) return sendError(res, 400, 'invalid_id', idP.error.issues[0]?.message ?? 'bad id');
    await pipeSse(req, res, threadStreamKey(idP.data.id));
  });

  async function pipeSse(req: Request, res: Response, streamKey: string): Promise<void> {
    if (activeSseCount >= SSE_POOL_MAX) {
      res.setHeader('Retry-After', '5');
      sendError(res, 503, 'sse_pool_exhausted', `SSE pool full (max ${SSE_POOL_MAX})`);
      return;
    }
    const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? '';
    const offsetCheck = parseQuery(StreamOffsetQuerySchema, { offset: req.query.offset });
    if (!offsetCheck.ok) {
      sendError(res, 400, 'invalid_offset', offsetCheck.message);
      return;
    }
    const offset = lastEventId || offsetCheck.value.offset || '$';

    activeSseCount++;
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    req.on('close', onClose);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write(': open\n\n');
    try {
      await forwardStreamToSse(streamKey, res, abort.signal, { fromOffset: offset });
    } finally {
      req.off('close', onClose);
      activeSseCount--;
      if (!res.writableEnded) res.end();
    }
  }
}

// parseStates removed — replaced by parseStatusList in jobs-schemas.ts.
