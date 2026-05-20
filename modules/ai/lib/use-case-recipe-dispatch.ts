/**
 * Dispatch helper — given a use-case ID that's bound to a recipe,
 * insert an ai_recipe_runs row and enqueue ai:run-recipe so the
 * recipe DAG executes via the existing worker.
 *
 * Used by consumer modules (daily-briefing's research, future:
 * editor-ai-copilot, attendee-matching) that previously called
 * runChat with hardcoded prompts. Routing through this helper means:
 *   - The bound recipe's instructions/prompt/parameters drive the run,
 *     not module-local hardcoded constants.
 *   - The recipe's response_schema is enforced by the recipe runner.
 *   - The Jobs tab + per-run provenance + cost-ledger all populate
 *     for free.
 *
 * Mirrors the inner block of api/recipe-sources.ts /recipes/:id/run
 * but takes a use-case ID instead of a recipe ID — the use-case's
 * recipe_source_id + recipe_file_path drive the lookup.
 */

import { enqueueRecipeRunJob, type EnqueueFn } from './jobs/enqueue.js';
import { pingRedis } from './jobs/redis-client.js';
import type { ParsedRecipe } from './recipes/parse-recipe.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = { from(table: string): any };

export interface DispatchUseCaseRecipeRunArgs {
  supabase: SupabaseLike;
  enqueueJob: EnqueueFn;
  useCaseId: string;
  userId?: string | null;
  hostKind?: string | null;
  hostId?: string | null;
  /** Recipe parameter values keyed by parameter name. */
  params?: Record<string, unknown>;
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export type DispatchUseCaseRecipeRunResult =
  | {
      ok: true;
      runId: string;
      jobId: string | undefined;
      delayed: boolean;
      recipe: {
        id: string;
        title: string;
        file_path: string;
        content_hash: string;
        last_commit_sha: string;
      };
    }
  | {
      ok: false;
      reason:
        | 'no_binding'
        | 'use_case_missing'
        | 'recipe_missing'
        | 'recipe_not_runnable'
        | 'sub_recipe_missing'
        | 'sub_recipe_not_runnable'
        | 'redis_unavailable'
        | 'insert_failed'
        | 'enqueue_failed';
      detail?: string;
    };

interface RecipeRow {
  id: string;
  source_id: string;
  file_path: string;
  version: string | null;
  title: string;
  description: string | null;
  instructions: string;
  prompt: string | null;
  parameters: unknown[];
  response_schema: unknown;
  settings: Record<string, unknown>;
  sub_recipe_refs: Array<{ path: string } & Record<string, unknown>>;
  extensions: unknown[];
  content_hash: string;
  last_commit_sha: string;
  parse_status: 'ok' | 'refused' | 'parse_error';
}

export async function dispatchUseCaseRecipeRun(
  args: DispatchUseCaseRecipeRunArgs,
): Promise<DispatchUseCaseRecipeRunResult> {
  const log = args.logger;

  // 1. Read the use-case row to find its recipe binding.
  const ucRes = await args.supabase
    .from('ai_use_cases')
    .select('id, recipe_source_id, recipe_file_path')
    .eq('id', args.useCaseId)
    .maybeSingle();
  if (ucRes?.error || !ucRes?.data) {
    return { ok: false, reason: 'use_case_missing', detail: ucRes?.error?.message };
  }
  const uc = ucRes.data as {
    id: string;
    recipe_source_id: string | null;
    recipe_file_path: string | null;
  };
  if (!uc.recipe_source_id || !uc.recipe_file_path) {
    return { ok: false, reason: 'no_binding' };
  }

  // 2. Load the recipe + sub-recipes.
  const recipeRes = await args.supabase
    .from('ai_recipes')
    .select('id, source_id, file_path, version, title, description, instructions, prompt, parameters, response_schema, settings, sub_recipe_refs, extensions, content_hash, last_commit_sha, parse_status')
    .eq('source_id', uc.recipe_source_id)
    .eq('file_path', uc.recipe_file_path)
    .maybeSingle();
  if (recipeRes?.error || !recipeRes?.data) {
    return { ok: false, reason: 'recipe_missing', detail: recipeRes?.error?.message };
  }
  const row = recipeRes.data as RecipeRow;
  if (row.parse_status !== 'ok') {
    return {
      ok: false,
      reason: 'recipe_not_runnable',
      detail: `parse_status='${row.parse_status}'`,
    };
  }

  const recipe: ParsedRecipe = {
    version: row.version,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    prompt: row.prompt,
    parameters: row.parameters as unknown as ParsedRecipe['parameters'],
    response_schema: row.response_schema as unknown as ParsedRecipe['response_schema'],
    settings: row.settings as unknown as ParsedRecipe['settings'],
    sub_recipes: row.sub_recipe_refs as unknown as ParsedRecipe['sub_recipes'],
    extensions: row.extensions as unknown as ParsedRecipe['extensions'],
    content_hash: row.content_hash,
  };

  const subRecipesSnapshot: Record<string, ParsedRecipe> = {};
  const subRecipeProvenance: Array<{ file_path: string; content_hash: string; last_commit_sha: string }> = [];
  if (recipe.sub_recipes.length > 0) {
    const paths = recipe.sub_recipes.map((s) => s.path);
    const subRes = await args.supabase
      .from('ai_recipes')
      .select('file_path, version, title, description, instructions, prompt, parameters, response_schema, settings, sub_recipe_refs, extensions, content_hash, last_commit_sha, parse_status')
      .eq('source_id', uc.recipe_source_id)
      .in('file_path', paths);
    const subRows = (subRes?.data as Array<RecipeRow> | null) ?? [];
    for (const sub of subRows) {
      if (sub.parse_status !== 'ok') {
        return {
          ok: false,
          reason: 'sub_recipe_not_runnable',
          detail: `${sub.file_path} parse_status='${sub.parse_status}'`,
        };
      }
      subRecipesSnapshot[sub.file_path] = {
        version: sub.version,
        title: sub.title,
        description: sub.description,
        instructions: sub.instructions,
        prompt: sub.prompt,
        parameters: sub.parameters as unknown as ParsedRecipe['parameters'],
        response_schema: sub.response_schema as unknown as ParsedRecipe['response_schema'],
        settings: sub.settings as unknown as ParsedRecipe['settings'],
        sub_recipes: sub.sub_recipe_refs as unknown as ParsedRecipe['sub_recipes'],
        extensions: sub.extensions as unknown as ParsedRecipe['extensions'],
        content_hash: sub.content_hash,
      };
      subRecipeProvenance.push({
        file_path: sub.file_path,
        content_hash: sub.content_hash,
        last_commit_sha: sub.last_commit_sha,
      });
    }
    for (const ref of recipe.sub_recipes) {
      if (!(ref.path in subRecipesSnapshot)) {
        return { ok: false, reason: 'sub_recipe_missing', detail: ref.path };
      }
    }
  }

  // 3. Sanity-check Redis before inserting — same precondition the
  // existing /recipes/:id/run endpoint enforces, so failures surface
  // as 'redis_unavailable' rather than as an orphan row with no
  // worker to pick it up.
  if (!(await pingRedis())) {
    return { ok: false, reason: 'redis_unavailable' };
  }

  // 4. Build the provenance snapshot (migration 023 shape).
  const sourceLookup = await args.supabase
    .from('ai_agent_sources')
    .select('id, label, git_url, branch, last_synced_commit')
    .eq('id', uc.recipe_source_id)
    .maybeSingle();
  const sourceRow = (sourceLookup?.data ?? null) as {
    id: string;
    label: string;
    git_url: string;
    branch: string;
    last_synced_commit: string | null;
  } | null;
  const recipeSource = {
    kind: 'source-registered' as const,
    recipe_id: row.id,
    file_path: row.file_path,
    content_hash: recipe.content_hash,
    last_commit_sha: row.last_commit_sha,
    source: sourceRow,
    sub_recipes: subRecipeProvenance,
  };

  // 5. Insert the run row.
  const insertRes = await args.supabase
    .from('ai_recipe_runs')
    .insert({
      recipe_id: row.id,
      recipe_file_path: row.file_path,
      recipe_content_hash: recipe.content_hash,
      user_id: args.userId ?? null,
      use_case: args.useCaseId,
      host_kind: args.hostKind ?? null,
      host_id: args.hostId ?? null,
      params: (args.params ?? {}) as Record<string, unknown>,
      status: 'queued',
      steps: [],
      recipe_snapshot: recipe as unknown as Record<string, unknown>,
      sub_recipes_snapshot: subRecipesSnapshot as unknown as Record<string, unknown>,
      recipe_source: recipeSource as unknown as Record<string, unknown>,
    })
    .select('id')
    .maybeSingle();
  if (insertRes?.error || !insertRes?.data) {
    return {
      ok: false,
      reason: 'insert_failed',
      detail: insertRes?.error?.message ?? 'no row returned',
    };
  }
  const runId = (insertRes.data as { id: string }).id;

  // 6. Enqueue + backfill bull_job_id.
  try {
    const enq = await enqueueRecipeRunJob(args.enqueueJob, {
      runId,
      useCase: args.useCaseId,
      recipeId: row.id,
      userId: args.userId ?? null,
    });
    await args.supabase
      .from('ai_recipe_runs')
      .update({ bull_job_id: enq.jobId ?? null })
      .eq('id', runId);

    log?.info('ai.use-case-recipe-dispatch.enqueued', {
      use_case: args.useCaseId,
      run_id: runId,
      job_id: enq.jobId,
      delayed: enq.delayed,
      recipe_id: row.id,
      file_path: row.file_path,
    });

    return {
      ok: true,
      runId,
      jobId: enq.jobId,
      delayed: enq.delayed,
      recipe: {
        id: row.id,
        title: row.title,
        file_path: row.file_path,
        content_hash: row.content_hash,
        last_commit_sha: row.last_commit_sha,
      },
    };
  } catch (err) {
    log?.warn('ai.use-case-recipe-dispatch.enqueue_failed', {
      use_case: args.useCaseId,
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: 'enqueue_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
