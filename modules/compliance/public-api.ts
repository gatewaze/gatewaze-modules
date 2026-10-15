import type { PublicApiContext } from '@gatewaze/shared';
import type { Router, Request, Response } from 'express';
import {
  PrivacyError, parseCreateInput, createRequest, getRequest, findByEmail, queuePreview,
  queueExecute, publicView, reportMarkdown, normaliseEmails, isUuid, type Actor,
} from './lib/privacy';

/**
 * Public API for privacy requests, mounted at /api/v1/privacy.
 *
 *   compliance:read   status and reports
 *   compliance:write  file a request and run its preview
 *   compliance:erase  run the erasure (kept separate so a key that files
 *                     requests can't also delete data)
 *
 * The MCP server calls these with its internal key and passes the signed-in
 * person's id as `person_id`, which is recorded as the actor.
 */

function actorFor(req: Request): Actor {
  const personId = (req.body as Record<string, unknown> | undefined)?.person_id ?? req.query.person_id;
  const key = req.apiKey;
  if (isUuid(personId)) return { via: 'mcp', label: `${personId} via ${key?.name ?? 'unknown key'}` };
  return { via: 'api', label: key ? `${key.name} (${key.id})` : 'unknown' };
}

function sendError(res: Response, e: unknown) {
  if (e instanceof PrivacyError) return res.status(e.status).json({ error: { code: e.code, message: e.message } });
  console.error('[compliance] public api error:', e);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

export function registerPublicApi(router: Router, ctx: PublicApiContext) {
  const supabase = ctx.supabase;
  // Present once the platform passes the queue to public API modules; until
  // then the worker's sweep runs queued requests within a minute.
  const enqueue = ctx.enqueueJob;

  router.post('/requests', ctx.requireScope('write') as never, async (req: Request, res: Response) => {
    try {
      const input = parseCreateInput(req.body);
      const row = await createRequest(supabase, input, actorFor(req));
      ctx.setCache(res, { kind: 'no-store' });
      res.status(201).json({ data: publicView(row) });
    } catch (e) { sendError(res, e); }
  });

  router.get('/requests', ctx.requireScope('read') as never, async (req: Request, res: Response) => {
    try {
      const [email] = normaliseEmails(String(req.query.email ?? ''));
      const rows = await findByEmail(supabase, email);
      ctx.setCache(res, { kind: 'no-store' });
      res.json({ data: rows.map(publicView) });
    } catch (e) { sendError(res, e); }
  });

  router.get('/requests/:id', ctx.requireScope('read') as never, async (req: Request, res: Response) => {
    try {
      ctx.setCache(res, { kind: 'no-store' });
      res.json({ data: publicView(await getRequest(supabase, String(req.params.id))) });
    } catch (e) { sendError(res, e); }
  });

  router.get('/requests/:id/report', ctx.requireScope('read') as never, async (req: Request, res: Response) => {
    try {
      const row = await getRequest(supabase, String(req.params.id));
      ctx.setCache(res, { kind: 'no-store' });
      res.json({ data: { id: row.id, status: row.status, markdown: reportMarkdown(row) } });
    } catch (e) { sendError(res, e); }
  });

  router.post('/requests/:id/preview', ctx.requireScope('write') as never, async (req: Request, res: Response) => {
    try {
      const row = await queuePreview(supabase, enqueue, String(req.params.id), actorFor(req));
      res.status(202).json({ data: publicView(row) });
    } catch (e) { sendError(res, e); }
  });

  router.post('/requests/:id/execute', ctx.requireScope('erase') as never, async (req: Request, res: Response) => {
    try {
      const row = await queueExecute(supabase, enqueue, String(req.params.id), (req.body as Record<string, unknown>)?.confirm_email, actorFor(req));
      res.status(202).json({ data: publicView(row) });
    } catch (e) { sendError(res, e); }
  });
}
