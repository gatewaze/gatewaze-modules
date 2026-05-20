/**
 * Recipe browsing + run endpoints.
 *
 * After migration 024 + the unified agent-sources surface, this file
 * only owns recipe-level operations (listing, reading, running). Source
 * CRUD moved to api/agent-sources.ts. The exported handler name stays
 * `mountRecipeSourceRoutes` for now to avoid an unnecessary
 * register-routes rename.
 *
 * Routes:
 *   GET    /recipes              — list recipes (browsing)
 *   GET    /recipes/:id          — read one recipe
 *   POST   /recipes/:id/run      — enqueue ai:run-recipe
 */

import type { Response, Router } from 'express';

import {
  listRecipes,
  readRecipe,
} from '../lib/recipes/recipes-repo.js';
import { type ParsedRecipe } from '../lib/recipes/parse-recipe.js';
import { runRecipe, type RecipeParamValue } from '../lib/recipes/run-recipe.js';
import { enqueueRecipeRunJob } from '../lib/jobs/enqueue.js';
import { getLastConnectError, pingRedis } from '../lib/jobs/redis-client.js';

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
  /** Resolves fetch_url for runChat steps that opt into the tool. */
  resolveFetchUrl?: Parameters<typeof runRecipe>[1]['resolveFetchUrl'];
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

async function requireAdmin(
  deps: Deps,
  userId: string | undefined,
  res: Response,
  requireSuperAdmin = false,
): Promise<boolean> {
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

// ─── Routes ──────────────────────────────────────────────────────────

export function mountRecipeSourceRoutes(router: Router, deps: Deps): void {
  // ─── RECIPES: LIST ────────────────────────────────────────────────
  router.get('/recipes', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    const sourceId = typeof req.query.source_id === 'string' ? req.query.source_id : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const parseStatus =
      req.query.parse_status === 'all' ||
      req.query.parse_status === 'refused' ||
      req.query.parse_status === 'parse_error'
        ? req.query.parse_status
        : undefined;
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
    const offset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : undefined;
    try {
      const recipes = await listRecipes(deps.supabase, {
        ...(sourceId && { source_id: sourceId }),
        ...(parseStatus && { parse_status: parseStatus }),
        ...(search && { search }),
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(Number.isFinite(offset) ? { offset } : {}),
      });
      res.status(200).json({ recipes });
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  });

  // ─── RECIPES: READ ───────────────────────────────────────────────
  router.get('/recipes/:id', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');
    const row = await readRecipe(deps.supabase, id);
    if (!row) return sendError(res, 404, 'not_found', 'recipe not found');
    res.status(200).json(row);
  });

  // ─── RECIPES: PER-ID RUN ──────────────────────────────────────────
  // Per spec §5.1: POST /recipes/:id/run launches a run against a
  // recipe persisted in ai_recipes. The body carries params + the
  // target use_case. Sub-recipes are resolved against the same source.
  router.post('/recipes/:id/run', async (req: RequestWithUser, res: Response) => {
    if (!(await requireAdmin(deps, req.userId, res))) return;
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'invalid_input', 'id required');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const useCase = typeof body.use_case === 'string' ? body.use_case : '';
    if (!useCase) return sendError(res, 400, 'invalid_input', 'body.use_case required');
    const params = (body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? (body.params as Record<string, RecipeParamValue>)
      : {}) as Record<string, RecipeParamValue>;
    const hostKind = typeof body.host_kind === 'string' ? body.host_kind : undefined;
    const hostId = typeof body.host_id === 'string' ? body.host_id : undefined;

    // Load the recipe row.
    const row = await readRecipe(deps.supabase, id);
    if (!row) return sendError(res, 404, 'not_found', 'recipe not found');
    if (row.parse_status !== 'ok') {
      return sendError(
        res,
        409,
        'recipe_not_runnable',
        `recipe parse_status='${row.parse_status}' — fix sync errors before running`,
      );
    }

    // Resolve sub-recipes from the same source. We re-parse from the
    // stored fields rather than the raw YAML to avoid re-running
    // parser logic on already-validated data. The recipe row stores
    // the parsed parameters / settings / sub_recipe_refs etc., so
    // building ParsedRecipe is a straight copy.
    const recipe: ParsedRecipe = {
      version: row.version,
      title: row.title,
      description: row.description,
      instructions: row.instructions,
      prompt: row.prompt,
      parameters: row.parameters as unknown as ParsedRecipe['parameters'],
      response_schema: row.response_schema,
      settings: row.settings as unknown as ParsedRecipe['settings'],
      sub_recipes: row.sub_recipe_refs as unknown as ParsedRecipe['sub_recipes'],
      extensions: row.extensions as unknown as ParsedRecipe['extensions'],
      content_hash: row.content_hash,
    };

    // Fetch sub-recipes (if any) from the same source.
    const subRecipes = new Map<string, ParsedRecipe>();
    if (recipe.sub_recipes.length > 0) {
      const paths = recipe.sub_recipes.map((s) => s.path);
      const subRes = await deps.supabase
        .from('ai_recipes')
        .select('*')
        .eq('source_id', row.source_id)
        .in('file_path', paths);
      const subRows = (subRes?.data as Array<typeof row> | null) ?? [];
      for (const subRow of subRows) {
        if (subRow.parse_status !== 'ok') {
          return sendError(
            res,
            409,
            'sub_recipe_not_runnable',
            `sub_recipe '${subRow.file_path}' has parse_status='${subRow.parse_status}'`,
          );
        }
        subRecipes.set(subRow.file_path, {
          version: subRow.version,
          title: subRow.title,
          description: subRow.description,
          instructions: subRow.instructions,
          prompt: subRow.prompt,
          parameters: subRow.parameters as unknown as ParsedRecipe['parameters'],
          response_schema: subRow.response_schema,
          settings: subRow.settings as unknown as ParsedRecipe['settings'],
          sub_recipes: subRow.sub_recipe_refs as unknown as ParsedRecipe['sub_recipes'],
          extensions: subRow.extensions as unknown as ParsedRecipe['extensions'],
          content_hash: subRow.content_hash,
        });
      }
      // Any sub-recipe referenced but missing → 404.
      for (const ref of recipe.sub_recipes) {
        if (!subRecipes.has(ref.path)) {
          return sendError(
            res,
            404,
            'sub_recipe_missing',
            `sub_recipe '${ref.path}' not found in source '${row.source_id}'`,
          );
        }
      }
    }

    // spec-ai-job-runner §5.1 — INSERT the run row + enqueue. No more
    // inline execution. The worker picks up the job and runs against
    // the row, streaming events to Redis.
    if (!deps.enqueueJob) {
      return sendError(res, 503, 'enqueue_unavailable', 'enqueueJob not wired by host');
    }
    if (!(await pingRedis())) {
      return sendError(
        res,
        503,
        'redis_unavailable',
        `Redis ping failed: ${getLastConnectError() ?? 'unknown'}`,
      );
    }

    const subRecipesSnapshot: Record<string, ParsedRecipe> = {};
    for (const [k, v] of subRecipes.entries()) subRecipesSnapshot[k] = v;

    // Provenance snapshot — migration 023. Captures the git source-ref
    // (label / commit sha) so an audit can answer "which version of
    // this recipe was used for that run" even after the source has
    // been updated/deleted.
    const sourceLookup = await deps.supabase
      .from('ai_agent_sources')
      .select('id, label, git_url, branch, last_synced_commit')
      .eq('id', row.source_id)
      .maybeSingle();
    const sourceRow = (sourceLookup?.data ?? null) as {
      id: string;
      label: string;
      git_url: string;
      branch: string;
      last_synced_commit: string | null;
    } | null;

    // Pull sub-recipe rows again (lightweight projection) for per-sub
    // commit shas. The full body is already in sub_recipes_snapshot.
    const subRecipeProvenance: Array<{
      file_path: string;
      content_hash: string;
      last_commit_sha: string;
    }> = [];
    if (recipe.sub_recipes.length > 0) {
      const subProv = await deps.supabase
        .from('ai_recipes')
        .select('file_path, content_hash, last_commit_sha')
        .eq('source_id', row.source_id)
        .in('file_path', recipe.sub_recipes.map((s) => s.path));
      for (const sr of (subProv?.data as Array<{
        file_path: string;
        content_hash: string;
        last_commit_sha: string;
      }> | null) ?? []) {
        subRecipeProvenance.push(sr);
      }
    }

    const recipeSource = {
      kind: 'source-registered' as const,
      recipe_id: id,
      file_path: row.file_path,
      content_hash: recipe.content_hash,
      last_commit_sha: row.last_commit_sha,
      source: sourceRow
        ? {
            id: sourceRow.id,
            label: sourceRow.label,
            git_url: sourceRow.git_url,
            branch: sourceRow.branch,
            last_synced_commit: sourceRow.last_synced_commit,
          }
        : null,
      sub_recipes: subRecipeProvenance,
    };

    const insertRes = await deps.supabase
      .from('ai_recipe_runs')
      .insert({
        recipe_id: id,
        recipe_file_path: row.file_path,
        recipe_content_hash: recipe.content_hash,
        user_id: req.userId ?? null,
        use_case: useCase,
        host_kind: hostKind ?? null,
        host_id: hostId ?? null,
        params: params as unknown as Record<string, unknown>,
        status: 'queued',
        steps: [],
        recipe_snapshot: recipe as unknown as Record<string, unknown>,
        sub_recipes_snapshot: subRecipesSnapshot as unknown as Record<string, unknown>,
        recipe_source: recipeSource as unknown as Record<string, unknown>,
      })
      .select('id')
      .maybeSingle();
    if (insertRes.error || !insertRes.data) {
      return sendError(res, 500, 'internal_error', insertRes.error?.message ?? 'no row returned');
    }
    const runId = insertRes.data.id as string;

    try {
      const enq = await enqueueRecipeRunJob(deps.enqueueJob, {
        runId,
        useCase,
        recipeId: id,
        userId: req.userId ?? null,
      });
      await deps.supabase
        .from('ai_recipe_runs')
        .update({ bull_job_id: enq.jobId ?? null })
        .eq('id', runId);
      res.status(202).json({
        run_id: runId,
        job_id: enq.jobId,
        delayed: enq.delayed,
        stream_url: `/api/modules/ai/admin/recipe-runs/${runId}/stream`,
      });
    } catch (err) {
      sendError(res, 500, 'enqueue_failed', err instanceof Error ? err.message : String(err));
    }
  });
}

// runRecipe is no longer called from the API; suppress unused-import
// noise without removing the import (still used by inline-fallback unit
// tests via direct import).
void runRecipe;
