/**
 * AI Skills — read-only endpoints (the writer is the sync worker).
 *
 *   GET /skills?source_id=&applies_to=&tag=    — list, filterable
 *   GET /skills/:id                             — full body
 *
 * The legacy `GET /skills/preview-prompt` endpoint that lived here when
 * skills were inside editor-ai-copilot has been removed from the ai
 * module. It was tightly coupled to the editor's host-adapter +
 * prompt-builder + block-defs surface — none of which belong in the
 * ai module's contract. If preview-rendering is needed long-term it
 * can be re-added either (a) under editor-ai-copilot's own routes, or
 * (b) as a host-agnostic API here that takes raw skill IDs + a budget
 * and returns the selection report without needing host adapters.
 */

import type { Response, Router } from 'express';
import {
  listSkills,
  readSkillFull,
  type ListSkillsFilter,
} from '../lib/skills/skills-repo.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

interface RequestWithUser {
  userId?: string;
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

interface Deps {
  supabase: SupabaseLike;
}

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

async function requireAdmin(deps: Deps, userId: string | undefined, res: Response): Promise<boolean> {
  if (!userId) {
    sendError(res, 401, 'unauthenticated', 'session required');
    return false;
  }
  const r = await deps.supabase
    .from('admin_profiles')
    .select('user_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  if (!r?.data) {
    sendError(res, 403, 'forbidden', 'admin access required');
    return false;
  }
  return true;
}

function parseCsvList(value: string | string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function mountSkillsRoutes(router: Router, deps: Deps): void {
  // ─── LIST ───────────────────────────────────────────────────────────
  router.get('/skills', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    const filter: ListSkillsFilter = {};
    if (typeof req.query.source_id === 'string' && req.query.source_id.length > 0) {
      filter.source_id = req.query.source_id;
    }
    // ?parse_status=all surfaces refused / parse_error rows for the
    // admin UI's diagnostics tab. Default is 'ok' (picker semantics).
    if (
      req.query.parse_status === 'all' ||
      req.query.parse_status === 'refused' ||
      req.query.parse_status === 'parse_error'
    ) {
      filter.parse_status = req.query.parse_status;
    }

    try {
      const skills = await listSkills(deps.supabase, filter);
      res.status(200).json({ skills });
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ─── READ ONE ───────────────────────────────────────────────────────
  router.get('/skills/:id', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');
    const row = await readSkillFull(deps.supabase, id);
    if (!row) return sendError(res, 404, 'not_found', 'skill not found');
    res.status(200).json(row);
  });
}
