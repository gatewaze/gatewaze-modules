/**
 * Sync one agent source — orchestrates the skill + recipe sync passes
 * for a single ai_agent_sources row.
 *
 * Calls the existing per-domain sync functions sequentially because:
 *   - Each claims its own row lock with a UUID token, so they can't
 *     conflict when run back-to-back.
 *   - Each handles its own clone/fetch + parse + upsert cycle —
 *     keeping the orchestration here thin means the skill + recipe
 *     parsers stay independently testable.
 *
 * Trade-off: the repo is cloned/fetched twice (once per pass). With
 * shallow clones + the existing fast-path on HEAD-SHA-unchanged, the
 * second pass usually skips the heavy work entirely. A future
 * optimisation can fold both walks behind a single clone if we measure
 * meaningful overhead.
 *
 * After both passes, this function updates the unified row's
 * skill_count + recipe_count rollups (added in migration 024) so the
 * admin UI can show repo composition without a second query.
 */

import { syncSource } from '../skills/sync-source.js';
import { syncRecipeSource } from '../recipes/sync-source.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface SyncAgentSourceArgs {
  supabase: SupabaseLike;
  sourceId: string;
  trigger: 'cron' | 'webhook' | 'manual';
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export interface SyncAgentSourceResult {
  ok: boolean;
  skills: {
    ok: boolean;
    reason?: string;
    filesIndexed?: number;
    filesSkipped?: number;
    warnings: string[];
  };
  recipes: {
    ok: boolean;
    reason?: string;
    filesIndexed?: number;
    filesSkipped?: number;
    warnings: string[];
  };
  durationMs: number;
  skill_count: number;
  recipe_count: number;
}

export async function syncAgentSource(args: SyncAgentSourceArgs): Promise<SyncAgentSourceResult> {
  const start = Date.now();
  const log = args.logger ?? consoleLogger();

  // Skills pass.
  const skillRes = await syncSource({
    supabase: args.supabase,
    sourceId: args.sourceId,
    trigger: args.trigger,
    logger: args.logger,
  });

  // Recipes pass.
  const recipeRes = await syncRecipeSource({
    supabase: args.supabase,
    sourceId: args.sourceId,
    trigger: args.trigger,
    logger: args.logger,
  });

  // Roll up counts onto the agent source row. We always read fresh
  // counts from the child tables rather than trusting the sync return
  // value — covers the case where a parallel sync wrote new rows
  // between the two passes.
  const [skillCount, recipeCount] = await Promise.all([
    countChildren(args.supabase, 'ai_skills', args.sourceId),
    countChildren(args.supabase, 'ai_recipes', args.sourceId),
  ]);

  await args.supabase
    .from('ai_agent_sources')
    .update({
      skill_count: skillCount,
      recipe_count: recipeCount,
    })
    .eq('id', args.sourceId);

  log.info('ai.agent-sync.complete', {
    source_id: args.sourceId,
    duration_ms: Date.now() - start,
    skills_ok: skillRes.ok,
    recipes_ok: recipeRes.ok,
    skill_count: skillCount,
    recipe_count: recipeCount,
  });

  return {
    ok: skillRes.ok || recipeRes.ok, // partial-ok if either pass landed
    skills: skillRes.ok
      ? {
          ok: true,
          filesIndexed: skillRes.filesIndexed,
          filesSkipped: skillRes.filesSkipped,
          warnings: skillRes.warnings,
        }
      : { ok: false, reason: skillRes.reason, warnings: skillRes.warnings },
    recipes: recipeRes.ok
      ? {
          ok: true,
          filesIndexed: (recipeRes as { recipesIndexed: number }).recipesIndexed,
          filesSkipped: (recipeRes as { recipesSkipped: number }).recipesSkipped,
          warnings: recipeRes.warnings,
        }
      : { ok: false, reason: recipeRes.reason, warnings: recipeRes.warnings },
    durationMs: Date.now() - start,
    skill_count: skillCount,
    recipe_count: recipeCount,
  };
}

async function countChildren(
  supabase: SupabaseLike,
  table: 'ai_skills' | 'ai_recipes',
  sourceId: string,
): Promise<number> {
  try {
    const r = await supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('source_id', sourceId);
    return (r?.count as number | null) ?? 0;
  } catch {
    return 0;
  }
}

function consoleLogger(): NonNullable<SyncAgentSourceArgs['logger']> {
  return {
    info: (msg, fields) => console.log(`[ai.agent-sync] ${msg}`, fields ?? ''),
    warn: (msg, fields) => console.warn(`[ai.agent-sync] ${msg}`, fields ?? ''),
    error: (msg, fields) => console.error(`[ai.agent-sync] ${msg}`, fields ?? ''),
  };
}
