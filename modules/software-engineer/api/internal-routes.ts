// @ts-nocheck — express + supabase resolved at module-host install time.
/**
 * Reporter-feedback internal API (migration 029). Mounted under `/internal/` (the platform's
 * modulesRouter JWT-gates everything under /api/modules/* EXCEPT paths containing `/internal/` — see
 * register-routes.ts), so this router gates itself with the shared x-gatewaze-internal-key
 * service-to-service header (the same convention lib/memory.ts uses when THIS module calls OUT to the
 * ai module). Only another module's backend (e.g. health-core), never a browser/mobile client, ever
 * calls these routes — the caller is trusted to have already resolved and ownership-checked the acting
 * person before it gets here, exactly like a GitHub webhook is trusted after its HMAC verifies.
 *
 * No route here can approve a gate, resume a run, or touch se_decisions/se_messages beyond appending a
 * role='reporter' note — see lib/reporter-feedback.ts's header comment for why that split is safe.
 */
import { Router } from 'express';
import { rateLimit, clientIp } from '../lib/rate-limit.js';
import {
  linkReporterReport,
  reporterQuestionsForPersons,
  runStatusForExternalReportIds,
  answerReporterQuestion,
} from '../lib/reporter-feedback.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTERNAL_SYSTEMS = new Set(['health_core']);

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function mountReporterRoutes(router, deps) {
  const { supabase, logger } = deps;
  const internalKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  router.use((req, res, next) => {
    if (!rateLimit(`se-reporter-internal:${clientIp(req)}`, 120, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const presented = req.headers['x-gatewaze-internal-key'];
    if (!internalKey || typeof presented !== 'string' || !timingSafeStringEqual(presented, internalKey)) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'missing or invalid internal key' } });
    }
    next();
  });

  // Idempotent write-back: new report → run mapping, or a one-time backfill of an already-created one.
  router.post('/reporter-links', async (req, res) => {
    const { runId, externalSystem, externalReportId, externalPersonId, isPrimary } = req.body ?? {};
    if (!UUID.test(runId) || !UUID.test(externalReportId) || !UUID.test(externalPersonId)) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'runId, externalReportId and externalPersonId must be uuids' } });
    }
    if (!EXTERNAL_SYSTEMS.has(externalSystem)) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'unknown externalSystem' } });
    }
    const { data: run } = await supabase.from('se_runs').select('id, site_id').eq('id', runId).maybeSingle();
    if (!run) return res.status(404).json({ error: { code: 'not_found', message: 'run not found' } });
    try {
      const link = await linkReporterReport(supabase, {
        runId, siteId: run.site_id, externalSystem, externalReportId, externalPersonId,
        isPrimary: isPrimary !== false,
      });
      res.status(201).json({ data: link });
    } catch (e) {
      logger?.error?.('reporter-links upsert failed', e);
      res.status(500).json({ error: { code: 'internal', message: 'could not record the link' } });
    }
  });

  // Reporter-safe questions for a set of external persons (health-core's own person ids), optionally
  // since a cursor timestamp for bounded polling reconciliation.
  router.get('/reporter-questions', async (req, res) => {
    const externalSystem = String(req.query.externalSystem ?? '');
    const raw = String(req.query.externalPersonIds ?? '');
    const externalPersonIds = raw.split(',').map((s) => s.trim()).filter((s) => UUID.test(s)).slice(0, 200);
    if (!EXTERNAL_SYSTEMS.has(externalSystem) || externalPersonIds.length === 0) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'externalSystem and externalPersonIds are required' } });
    }
    const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : null;
    try {
      const questions = await reporterQuestionsForPersons(supabase, { externalSystem, externalPersonIds, since });
      res.json({ data: questions });
    } catch (e) {
      logger?.error?.('reporter-questions query failed', e);
      res.status(500).json({ error: { code: 'internal', message: 'could not load questions' } });
    }
  });

  // Reporter-safe run lifecycle snapshot for a set of external report ids (health-core's hc_feedback.id).
  router.get('/run-status', async (req, res) => {
    const externalSystem = String(req.query.externalSystem ?? '');
    const raw = String(req.query.externalReportIds ?? '');
    const externalReportIds = raw.split(',').map((s) => s.trim()).filter((s) => UUID.test(s)).slice(0, 200);
    if (!EXTERNAL_SYSTEMS.has(externalSystem) || externalReportIds.length === 0) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'externalSystem and externalReportIds are required' } });
    }
    try {
      const statuses = await runStatusForExternalReportIds(supabase, { externalSystem, externalReportIds });
      res.json({ data: statuses });
    } catch (e) {
      logger?.error?.('run-status query failed', e);
      res.status(500).json({ error: { code: 'internal', message: 'could not load run status' } });
    }
  });

  // Compare-and-set answer. The caller (health-core) has already verified the acting person owns the
  // report this question's run is linked to before calling this.
  router.post('/reporter-answers', async (req, res) => {
    const { questionId, revision, answer, idempotencyKey } = req.body ?? {};
    if (!UUID.test(questionId) || typeof revision !== 'number' || !answer || typeof idempotencyKey !== 'string' || !idempotencyKey) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'questionId, revision, answer and idempotencyKey are required' } });
    }
    if (idempotencyKey.length > 200) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'idempotencyKey too long' } });
    }
    try {
      const result = await answerReporterQuestion(supabase, { questionId, revision, answer, idempotencyKey });
      if (!result.ok) return res.status(result.status ?? 500).json({ error: result.error });
      res.status(result.replayed ? 200 : 201).json({ data: result.answer, replayed: result.replayed });
    } catch (e) {
      logger?.error?.('reporter-answers failed', e);
      res.status(500).json({ error: { code: 'internal', message: 'could not record the answer' } });
    }
  });
}
