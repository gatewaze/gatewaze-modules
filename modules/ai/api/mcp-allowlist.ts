// @ts-nocheck — depends on express + supabase resolved at host install.

/**
 * spec-ai-mcp-extensions.md §API — per-use-case MCP allowlist CRUD.
 *
 *   GET    /admin/use-cases/:use_case_id/mcp-allowlist     list
 *   PUT    /admin/use-cases/:use_case_id/mcp-allowlist     replace (idempotent)
 *
 * Server NAMES on the wire, ids in storage. PUT body: { allowed_server_names: string[] }.
 */

import type { Router, Request, Response } from 'express';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

interface MountDeps { supabase: SupabaseLike }

function sendError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } });
}

export function mountMcpAllowlistRoutes(router: Router, deps: MountDeps): void {
  router.get('/admin/use-cases/:use_case_id/mcp-allowlist', async (req: Request, res: Response): Promise<void> => {
    const useCaseId = req.params.use_case_id;
    if (!useCaseId) return sendError(res, 400, 'bad_request', 'use_case_id required');
    const rows = await deps.supabase
      .from('ai_use_case_mcp_allowlist')
      .select('mcp_server_id, ai_mcp_servers(name, display_name, type, enabled)')
      .eq('use_case_id', useCaseId);
    if (rows.error) return sendError(res, 500, 'internal_error', rows.error.message);
    const allowed = (rows.data ?? []).map((r: Record<string, unknown>) => {
      const srv = (r.ai_mcp_servers ?? {}) as { name?: string; display_name?: string; type?: string; enabled?: boolean };
      return {
        server_id: r.mcp_server_id,
        name: srv.name,
        display_name: srv.display_name,
        type: srv.type,
        enabled: srv.enabled,
      };
    });
    res.status(200).json({ allowed });
  });

  router.put('/admin/use-cases/:use_case_id/mcp-allowlist', async (req: Request, res: Response): Promise<void> => {
    const useCaseId = req.params.use_case_id;
    if (!useCaseId) return sendError(res, 400, 'bad_request', 'use_case_id required');
    const body = (req.body ?? {}) as { allowed_server_names?: unknown };
    if (!Array.isArray(body.allowed_server_names)) {
      return sendError(res, 400, 'validation_error', 'allowed_server_names must be a string array');
    }
    // Dedupe + validate string shape.
    const names = Array.from(new Set(body.allowed_server_names.filter((n): n is string => typeof n === 'string')));
    if (names.length > 100) return sendError(res, 400, 'validation_error', 'allowed_server_names capped at 100');

    // Verify the use case exists (clearer error than the join failing).
    const ucRes = await deps.supabase
      .from('ai_use_cases')
      .select('id', { head: true, count: 'exact' })
      .eq('id', useCaseId);
    if (ucRes.error) return sendError(res, 500, 'internal_error', ucRes.error.message);
    if ((ucRes.count ?? 0) === 0) return sendError(res, 404, 'not_found', 'use case not found');

    // Resolve names → ids; reject if any unknown.
    let serverRows: Array<{ id: string; name: string }> = [];
    if (names.length > 0) {
      const srvRes = await deps.supabase
        .from('ai_mcp_servers')
        .select('id, name')
        .in('name', names);
      if (srvRes.error) return sendError(res, 500, 'internal_error', srvRes.error.message);
      serverRows = (srvRes.data ?? []) as Array<{ id: string; name: string }>;
      const found = new Set(serverRows.map((r) => r.name));
      const missing = names.filter((n) => !found.has(n));
      if (missing.length > 0) {
        return sendError(res, 400, 'validation_error', `unknown MCP server names: ${missing.join(', ')}`);
      }
    }

    // Atomic-ish replace: delete then insert. Should be one transaction
    // ideally; supabase-js doesn't expose multi-statement TX, so we do
    // it sequentially and accept a brief gap (the use-case wouldn't
    // be running a job mid-edit in practice).
    const del = await deps.supabase
      .from('ai_use_case_mcp_allowlist')
      .delete()
      .eq('use_case_id', useCaseId);
    if (del.error) return sendError(res, 500, 'internal_error', del.error.message);

    if (serverRows.length > 0) {
      const ins = await deps.supabase
        .from('ai_use_case_mcp_allowlist')
        .insert(serverRows.map((r) => ({ use_case_id: useCaseId, mcp_server_id: r.id })));
      if (ins.error) return sendError(res, 500, 'internal_error', ins.error.message);
    }

    res.status(200).json({ allowed_server_names: names });
  });
}
