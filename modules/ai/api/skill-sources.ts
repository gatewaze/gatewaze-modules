/**
 * AI Skills — admin endpoints for managing skill sources.
 *
 * Per spec-ai-skills.md §10.1. Auth: the parent register-routes layer
 * applies a JWT-decode middleware that populates req.userId; we
 * additionally check the caller is an admin via admin_profiles.
 *
 * Routes:
 *   GET    /skill-sources
 *   POST   /skill-sources
 *   GET    /skill-sources/:id
 *   PATCH  /skill-sources/:id                (RFC 7396 merge patch)
 *   DELETE /skill-sources/:id
 *   POST   /skill-sources/:id/sync           (manual sync)
 *   POST   /skill-sources/:id/test-connection
 *   POST   /skill-sources/:id/rotate-webhook-secret
 *   GET    /skill-sources/:id/webhook-log?limit=
 */

import type { Response, Router } from 'express';
import {
  createSource,
  deleteSource,
  listSources,
  listWebhookLog,
  readSource,
  rotateWebhookSecret,
  updateSource,
  type UpdateSourceInput,
} from '../lib/skills/skills-repo.js';
import { gitLsRemote, GitError } from '../lib/skills/git-client.js';
import { decryptSecret } from '../lib/skills/secret-shim.js';
import { skillsConfig } from '../lib/skills/skills-config.js';

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
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string }>;
}

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

async function requireAdmin(deps: Deps, userId: string | undefined, res: Response, requireSuperAdmin = false): Promise<boolean> {
  if (!userId) {
    sendError(res, 401, 'unauthenticated', 'session required');
    return false;
  }
  try {
    const r = await deps.supabase
      .from('admin_profiles')
      .select('role')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    const row = r?.data as { role?: string } | null;
    if (!row) {
      sendError(res, 403, 'forbidden', 'admin access required');
      return false;
    }
    if (requireSuperAdmin && row.role !== 'super_admin') {
      sendError(res, 403, 'forbidden', 'super_admin access required');
      return false;
    }
    return true;
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function mountSkillSourceRoutes(router: Router, deps: Deps): void {
  // ─── LIST ───────────────────────────────────────────────────────────
  router.get('/skill-sources', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    try {
      const sources = await listSources(deps.supabase);
      res.status(200).json({ sources });
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ─── CREATE ─────────────────────────────────────────────────────────
  router.post('/skill-sources', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res, true))) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const git_url = typeof body.git_url === 'string' ? body.git_url.trim() : '';
    if (!label) return sendError(res, 400, 'invalid_input', 'label is required');
    if (!git_url) return sendError(res, 400, 'invalid_input', 'git_url is required');
    if (!git_url.startsWith('https://')) {
      return sendError(res, 400, 'invalid_input', 'git_url must start with https://');
    }
    const branch = typeof body.branch === 'string' ? body.branch.trim() : 'main';
    const path_prefix = typeof body.path_prefix === 'string' ? body.path_prefix.trim() : '';
    if (!isPathPrefixSafe(path_prefix)) {
      return sendError(res, 400, 'invalid_input', 'path_prefix contains forbidden characters or traversal');
    }
    const description = typeof body.description === 'string' ? body.description : undefined;
    const auth_token = typeof body.auth_token === 'string' && body.auth_token.length > 0 ? body.auth_token : undefined;
    const webhook_provider =
      body.webhook_provider === 'gitlab' || body.webhook_provider === 'gitea' ? body.webhook_provider : 'github';

    const result = await createSource(deps.supabase, {
      label,
      description,
      git_url,
      branch,
      path_prefix,
      auth_token,
      webhook_provider,
      created_by: req.userId,
    });
    if (!result.ok) return sendError(res, 500, 'internal_error', result.reason);
    res.status(201).json({ ...result.row, webhook_secret: result.webhook_secret });
  });

  // ─── READ ───────────────────────────────────────────────────────────
  router.get('/skill-sources/:id', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');
    const row = await readSource(deps.supabase, id);
    if (!row) return sendError(res, 404, 'not_found', 'skill source not found');
    res.status(200).json(row);
  });

  // ─── PATCH (RFC 7396 merge-patch) ──────────────────────────────────
  router.patch('/skill-sources/:id', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res, true))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');
    const body = (req.body ?? {}) as Record<string, unknown>;

    const patch: UpdateSourceInput = {};
    if (typeof body.label === 'string') patch.label = body.label.trim();
    if ('description' in body) patch.description = body.description == null ? null : String(body.description);
    if (typeof body.git_url === 'string') {
      if (!body.git_url.startsWith('https://')) {
        return sendError(res, 400, 'invalid_input', 'git_url must start with https://');
      }
      patch.git_url = body.git_url.trim();
    }
    if (typeof body.branch === 'string') patch.branch = body.branch.trim();
    if (typeof body.path_prefix === 'string') {
      if (!isPathPrefixSafe(body.path_prefix)) {
        return sendError(res, 400, 'invalid_input', 'path_prefix contains forbidden characters or traversal');
      }
      patch.path_prefix = body.path_prefix.trim();
    }
    if (typeof body.webhook_provider === 'string' && ['github', 'gitlab', 'gitea'].includes(body.webhook_provider)) {
      patch.webhook_provider = body.webhook_provider as 'github' | 'gitlab' | 'gitea';
    }
    // Tri-state auth_token: absent → preserve; string → re-encrypt; null → clear.
    if ('auth_token' in body) {
      if (body.auth_token === null) patch.auth_token = null;
      else if (typeof body.auth_token === 'string') patch.auth_token = body.auth_token;
    }

    const result = await updateSource(deps.supabase, id, patch);
    if (!result.ok) return sendError(res, 500, 'internal_error', result.reason);
    res.status(200).json(result.row);
  });

  // ─── DELETE ─────────────────────────────────────────────────────────
  router.delete('/skill-sources/:id', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res, true))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');
    const result = await deleteSource(deps.supabase, id);
    if (!result.deleted) return sendError(res, 500, 'internal_error', result.reason);
    res.status(200).json({ deleted: true, cascaded_skill_count: result.cascadedSkillCount });
  });

  // ─── SYNC NOW ───────────────────────────────────────────────────────
  router.post('/skill-sources/:id/sync', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');
    if (!deps.enqueueJob) {
      return sendError(res, 503, 'internal_error', 'job enqueue helper unavailable in this runtime');
    }
    // Verify source exists first.
    const row = await readSource(deps.supabase, id);
    if (!row) return sendError(res, 404, 'not_found', 'skill source not found');

    try {
      const job = await deps.enqueueJob('jobs', 'ai.sync-one-skill-source', {
        kind: 'ai.sync-one-skill-source',
        source_id: id,
        trigger: 'manual',
      });
      res.status(202).json({ job_id: job.id, status: 'queued' });
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ─── TEST CONNECTION ────────────────────────────────────────────────
  router.post('/skill-sources/:id/test-connection', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');
    // Read the FULL row (need ciphertext + branch).
    const fullRes = await deps.supabase
      .from('ai_skill_sources')
      .select('git_url, branch, auth_token_ciphertext')
      .eq('id', id)
      .maybeSingle();
    const row = fullRes?.data as { git_url: string; branch: string; auth_token_ciphertext: string | null } | null;
    if (!row) return sendError(res, 404, 'not_found', 'skill source not found');

    const authToken = row.auth_token_ciphertext ? decryptSecret(row.auth_token_ciphertext) : null;
    try {
      const headSha = await gitLsRemote({
        url: row.git_url,
        branch: row.branch,
        authToken,
        timeoutMs: Math.min(5000, skillsConfig.skillSyncTimeoutMs),
      });
      res.status(200).json({ ok: true, head_sha: headSha });
    } catch (err) {
      const code = err instanceof GitError ? err.code : 'git_error';
      const message = err instanceof Error ? err.message : String(err);
      res.status(200).json({ ok: false, error: `${code}: ${message}` });
    }
  });

  // ─── ROTATE WEBHOOK SECRET ──────────────────────────────────────────
  router.post('/skill-sources/:id/rotate-webhook-secret', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res, true))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');
    const result = await rotateWebhookSecret(deps.supabase, id);
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 500;
      return sendError(res, status, result.reason === 'not_found' ? 'not_found' : 'internal_error', result.reason);
    }
    res.status(200).json({ webhook_secret: result.webhook_secret });
  });

  // ─── WEBHOOK LOG ────────────────────────────────────────────────────
  router.get('/skill-sources/:id/webhook-log', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50;
    const events = await listWebhookLog(deps.supabase, id, limit);
    res.status(200).json({ events });
  });
}

function isPathPrefixSafe(p: string): boolean {
  if (p === '') return true;
  if (p.startsWith('/')) return false;
  if (p.split('/').some((seg) => seg === '..')) return false;
  return /^[A-Za-z0-9_./-]+$/.test(p);
}
