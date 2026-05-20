// @ts-nocheck — depends on express + supabase resolved at host install.

/**
 * spec-ai-mcp-extensions.md §Memory backing store §Admin UI.
 *
 *   GET    /admin/memory?use_case=X[&thread_id=Y]   list entries
 *   DELETE /admin/memory/:id                        delete entry
 *
 * Read-only inspection of the gatewaze-memory MCP server's backing
 * store. Operators can see what models have remembered + delete
 * individual entries (the model can rewrite on the next turn).
 */

import type { Router, Request, Response } from 'express';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

interface MountDeps { supabase: SupabaseLike }

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function mountMemoryRoutes(router: Router, deps: MountDeps): void {
  router.get('/admin/memory', async (req: Request, res: Response): Promise<void> => {
    const useCaseId = typeof req.query.use_case === 'string' ? req.query.use_case : undefined;
    const threadId = typeof req.query.thread_id === 'string' ? req.query.thread_id : undefined;
    const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    if (!useCaseId) return sendError(res, 400, 'bad_request', 'use_case query param required');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = deps.supabase
      .from('ai_memory')
      .select('id, scope, thread_id, user_id, key, value, expires_at, written_by_message_id, created_at, updated_at')
      .eq('use_case', useCaseId)
      .order('updated_at', { ascending: false })
      .limit(500);
    if (scope) q = q.eq('scope', scope);
    if (threadId) q = q.eq('thread_id', threadId);

    const result = await q;
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);

    // Filter out expired client-side (defence-in-depth; the cron deletes
    // them eventually).
    const now = Date.now();
    const entries = (result.data ?? []).filter((r: { expires_at: string | null }) => {
      if (!r.expires_at) return true;
      return new Date(r.expires_at).getTime() > now;
    });
    res.status(200).json({ entries });
  });

  router.delete('/admin/memory/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'bad_request', 'id required');
    const result = await deps.supabase.from('ai_memory').delete().eq('id', id);
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
    res.status(204).send();
  });
}
