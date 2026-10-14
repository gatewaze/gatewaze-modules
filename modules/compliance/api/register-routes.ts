// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * Compliance admin routes under /api/modules/compliance/*.
 *
 * The platform does not gate dynamic module routes, so this router does its
 * own auth: a verified Supabase session (requireJwt) and an active
 * super_admin or admin profile. Editors can see the compliance page but
 * can't run erasures.
 */

if (typeof (globalThis as Record<string, unknown>).WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = class {
    addEventListener() {} removeEventListener() {} close() {} send() {}
  };
}

import { Router, type Express } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireJwt } from '../lib/require-jwt.js';
import { clientIp, rateLimit } from '../lib/rate-limit.js';
import {
  PrivacyError, parseCreateInput, createRequest, getRequest, queuePreview, queueExecute,
  queueProcessorRetry, setChecklistItem, reportMarkdown,
} from '../lib/privacy.js';

interface RegisterCtx {
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

function sendError(res, e) {
  if (e instanceof PrivacyError) return res.status(e.status).json({ error: { code: e.code, message: e.message } });
  console.error('[compliance] admin route error:', e);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

export async function registerRoutes(app: Express, ctx?: RegisterCtx): Promise<void> {
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const enqueue = ctx?.enqueueJob;
  const r = Router();

  // Rate limit before auth so an unauthenticated flood is cheap to reject.
  r.use((req, res, next) => {
    if (!rateLimit(`compliance:${clientIp(req)}`, 120, 60_000)) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    }
    next();
  });
  r.use(requireJwt());
  r.use(async (req, res, next) => {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'No session' } });
    const { data } = await supabase.from('admin_profiles').select('role, is_active').eq('user_id', userId).maybeSingle();
    if (!data?.is_active || !['super_admin', 'admin'].includes(data.role)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }
    req.complianceActor = { via: 'admin', label: userId };
    next();
  });

  r.post('/privacy-requests', async (req, res) => {
    try {
      const input = parseCreateInput(req.body);
      const row = await createRequest(supabase, input, req.complianceActor);
      await supabase.from('compliance_privacy_requests').update({ processed_by: req.userId }).eq('id', row.id);
      res.status(201).json({ data: row });
    } catch (e) { sendError(res, e); }
  });

  r.get('/privacy-requests/:id', async (req, res) => {
    try { res.json({ data: await getRequest(supabase, req.params.id) }); } catch (e) { sendError(res, e); }
  });

  r.get('/privacy-requests/:id/report.md', async (req, res) => {
    try {
      const row = await getRequest(supabase, req.params.id);
      res.type('text/markdown').send(reportMarkdown(row));
    } catch (e) { sendError(res, e); }
  });

  r.post('/privacy-requests/:id/preview', async (req, res) => {
    try { res.status(202).json({ data: await queuePreview(supabase, enqueue, req.params.id, req.complianceActor) }); } catch (e) { sendError(res, e); }
  });

  r.post('/privacy-requests/:id/execute', async (req, res) => {
    try {
      res.status(202).json({ data: await queueExecute(supabase, enqueue, req.params.id, req.body?.confirm_email, req.complianceActor) });
    } catch (e) { sendError(res, e); }
  });

  r.post('/privacy-requests/:id/retry-processors', async (req, res) => {
    try { res.status(202).json({ data: await queueProcessorRetry(supabase, enqueue, req.params.id, req.complianceActor) }); } catch (e) { sendError(res, e); }
  });

  r.post('/privacy-requests/:id/checklist/:itemId', async (req, res) => {
    try {
      const itemId = String(req.params.itemId).slice(0, 100);
      res.json({ data: await setChecklistItem(supabase, enqueue, req.params.id, itemId, req.body?.done === true, req.complianceActor) });
    } catch (e) { sendError(res, e); }
  });

  // Personal-looking columns no registry entry covers, for the admin page.
  r.get('/coverage', async (_req, res) => {
    const { data, error } = await supabase.rpc('compliance_erasure_coverage');
    if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });
    res.json({ data: data ?? [] });
  });

  app.use('/api/modules/compliance', r);
  console.log('[compliance] admin routes registered');
}
