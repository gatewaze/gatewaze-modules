/**
 * Dispatch a buzzword-extract recipe run and enqueue it for the worker.
 *
 * Why inlined rather than calling the ai module's dispatchUseCaseRecipeRun:
 *   - The platform's worker dispatcher invokes handlers as `handler(job)` —
 *     it does NOT thread a ctx.enqueueJob through (documented in the ai
 *     module's sync-agent-sources handler). So a worker can't use the
 *     runtime's enqueue helper; it must talk to BullMQ directly.
 *   - Importing across module packages risks the dual-workspace symlink
 *     breakage this repo has hit before. This recipe has no sub-recipes, so
 *     a focused local dispatch is small and dependency-free.
 *
 * Shape mirrors dispatchUseCaseRecipeRun: read the use-case → recipe, snapshot
 * the recipe onto the run row (so the worker executes exactly what was
 * dispatched), enqueue `ai:run-recipe` on the shared `jobs` queue.
 */

import { Queue } from 'bullmq';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = { from(table: string): any };

export const BUZZWORD_USE_CASE = 'newsletter-buzzword-extract';
const RECIPE_FILE_PATH = 'recipes/newsletter-buzzword-extract/recipe.yaml';

/** BullMQ queue prefix the platform's worker consumes: `bull:<brand>`. */
function bullPrefix(): string {
  return `bull:${process.env.BRAND ?? 'default'}`;
}

/** Construct a Queue bound to the same keyspace as the platform worker. */
function jobsQueue(): Queue {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return new Queue('jobs', {
    prefix: bullPrefix(),
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
    },
  });
}

export interface DispatchResult {
  ok: boolean;
  runId?: string;
  jobId?: string;
  reason?: string;
}

/**
 * Insert an ai_recipe_runs row for the buzzword use-case and enqueue it.
 * `params` are the recipe parameter values (replies, known_phrases, …).
 */
export async function dispatchBuzzwordRun(
  supabase: SupabaseLike,
  params: Record<string, unknown>,
): Promise<DispatchResult> {
  // 1. Resolve the use-case → recipe source binding.
  const ucRes = await supabase
    .from('ai_use_cases')
    .select('id, recipe_source_id, recipe_file_path')
    .eq('id', BUZZWORD_USE_CASE)
    .maybeSingle();
  const uc = ucRes?.data as
    | { id: string; recipe_source_id: string | null; recipe_file_path: string | null }
    | null;
  if (!uc?.recipe_source_id || !uc.recipe_file_path) {
    return { ok: false, reason: 'use_case_unbound' };
  }

  // 2. Load the recipe row (source-scoped) to snapshot onto the run.
  const rRes = await supabase
    .from('ai_recipes')
    .select(
      'id, version, title, description, instructions, prompt, parameters, response_schema, settings, sub_recipe_refs, extensions, content_hash, last_commit_sha, parse_status',
    )
    .eq('source_id', uc.recipe_source_id)
    .eq('file_path', uc.recipe_file_path)
    .maybeSingle();
  const rec = rRes?.data as
    | {
        id: string;
        version: string | null;
        title: string;
        description: string | null;
        instructions: string;
        prompt: string | null;
        parameters: unknown[];
        response_schema: unknown;
        settings: Record<string, unknown>;
        sub_recipe_refs: unknown[];
        extensions: unknown[];
        content_hash: string;
        last_commit_sha: string;
        parse_status: string;
      }
    | null;
  if (!rec) return { ok: false, reason: 'recipe_missing' };
  if (rec.parse_status !== 'ok') return { ok: false, reason: `recipe_not_runnable:${rec.parse_status}` };

  const snapshot = {
    version: rec.version,
    title: rec.title,
    description: rec.description,
    instructions: rec.instructions,
    prompt: rec.prompt,
    parameters: rec.parameters,
    response_schema: rec.response_schema,
    settings: rec.settings,
    sub_recipes: rec.sub_recipe_refs,
    extensions: rec.extensions,
    content_hash: rec.content_hash,
  };

  // 3. Insert the queued run row.
  const insRes = await supabase
    .from('ai_recipe_runs')
    .insert({
      recipe_id: rec.id,
      recipe_file_path: uc.recipe_file_path,
      recipe_content_hash: rec.content_hash,
      use_case: BUZZWORD_USE_CASE,
      params,
      status: 'queued',
      steps: [],
      recipe_snapshot: snapshot,
      sub_recipes_snapshot: {},
      recipe_source: {
        kind: 'source-registered',
        recipe_id: rec.id,
        file_path: uc.recipe_file_path,
        content_hash: rec.content_hash,
        last_commit_sha: rec.last_commit_sha,
        sub_recipes: [],
      },
    })
    .select('id')
    .maybeSingle();
  const runId = (insRes?.data as { id: string } | null)?.id;
  if (!runId) return { ok: false, reason: `insert_failed:${insRes?.error?.message ?? 'no_row'}` };

  // 4. Enqueue for the run-recipe worker, then record the job id.
  let queue: Queue | null = null;
  try {
    queue = jobsQueue();
    const job = await queue.add('ai:run-recipe', {
      runId,
      useCase: BUZZWORD_USE_CASE,
      enqueuedAt: new Date().toISOString(),
    });
    await supabase.from('ai_recipe_runs').update({ bull_job_id: job.id ?? null }).eq('id', runId);
    return { ok: true, runId, jobId: job.id };
  } catch (err) {
    // Mark the orphan run failed so it isn't left dangling as 'queued'.
    await supabase
      .from('ai_recipe_runs')
      .update({ status: 'failed', failure_reason: 'enqueue_failed', completed_at: new Date().toISOString() })
      .eq('id', runId);
    return { ok: false, runId, reason: `enqueue_failed:${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}

export { RECIPE_FILE_PATH };
