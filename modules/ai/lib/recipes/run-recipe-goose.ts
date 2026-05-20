/**
 * Recipe executor — spawns `goose run --recipe ... --output-format stream-json`.
 *
 * Replaces the in-house TypeScript executor for v2. Rationale: every
 * recipe authored locally with the Goose CLI is now guaranteed to run
 * with identical semantics in production. Skill auto-loading, stdio
 * MCP extensions (`uvx <pkg>`, `npx <pkg>`), sub-recipe output
 * forwarding, and the rest of Goose's recipe runtime come "for free"
 * instead of being reimplemented in the platform.
 *
 * Architecture per run:
 *   1. mkdtemp under /tmp/gatewaze-goose-<runId>.
 *   2. Serialize the parsed recipe + sub-recipes back to YAML inside
 *      the tmpdir. Sub-recipe paths are normalized so the
 *      `path: ../foo/recipe.yaml` references inside the parent
 *      resolve against the materialized layout.
 *   3. Spawn `goose run` with --no-session (the platform owns
 *      session storage), --quiet (no human-readable banner), and
 *      --output-format stream-json (NDJSON event stream). Provider
 *      keys are passed via env vars the platform already has set on
 *      the worker (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).
 *   4. Stream Goose's NDJSON stdout — Message / Notification /
 *      Error / Complete events. Message events with assistant text
 *      become Redis Stream entries on `ai:run:<runId>` so the Jobs
 *      tab live-tail surfaces real-time progress. The terminal
 *      Message with a `submit_result` tool-request carries the
 *      structured output that matches the recipe's response_schema.
 *   5. The Complete event carries total/input/output token counts —
 *      written verbatim to ai_usage_events via recordUsage() so the
 *      cost ledger captures recipe spend the same way it captures
 *      chat spend.
 *   6. Update ai_recipe_runs (status, final_output, totals, duration)
 *      and resolve.
 *
 * Cancellation: SIGTERM the child after the CANCELLATION_GRACE_MS
 * window; the in-flight provider call inside Goose either finishes
 * or its socket closes. Cleanup runs in a finally block regardless
 * of how the run exits.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { Readable } from 'node:stream';

import { dump as yamlDump } from 'js-yaml';
import { recordUsage } from '../cost.js';
import type { ParsedRecipe } from './parse-recipe.js';
import type { RunnerContext } from '../runner.js';

const GOOSE_BIN = process.env.GOOSE_BIN ?? '/usr/local/bin/goose';
const CANCELLATION_GRACE_MS = 5_000;
const MAX_RUN_DURATION_MS = 30 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any; rpc?: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> };

export interface RunRecipeViaGooseArgs {
  recipe: ParsedRecipe;
  subRecipes: Map<string, ParsedRecipe>;
  params: Record<string, unknown>;
  userId: string | null;
  useCase: string;
  hostKind?: string;
  hostId?: string;
  recipeId?: string;
  recipeFilePath?: string;
  /**
   * Pre-allocated ai_recipe_runs row id (worker-dispatch path always
   * supplies this; the API INSERTs with status='queued' before
   * enqueuing). Inline callers can omit; we'll INSERT here.
   */
  runId?: string;
  /**
   * Streaming hooks the worker handler wires to Redis Stream XADD.
   * Fired around each Goose stream event so the Jobs tab + chat
   * widget see progress in real time.
   */
  onStreamEvent?: (event: GooseStreamEvent) => Promise<void> | void;
}

export interface RunRecipeViaGooseResult {
  run_id: string;
  status: 'complete' | 'failed' | 'cancelled' | 'budget_blocked';
  final_output: Record<string, unknown> | string | null;
  total_cost_micro_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  duration_ms: number;
  failure_reason?: string;
}

/**
 * One event off Goose's --output-format=stream-json NDJSON stream.
 * We accept whatever shape Goose emits; downstream code consults
 * .type and pulls the fields it knows about. Unknown event types
 * are passed through to the stream hook so future Goose events
 * (e.g. new notification kinds) don't crash the worker.
 */
export interface GooseStreamEvent {
  type: 'Message' | 'Notification' | 'Error' | 'Complete' | string;
  // Per-event payload — Goose's serde tag names line up well enough
  // for us to treat the rest as opaque JSON.
  [key: string]: unknown;
}

/**
 * Top-level entry point. Mirrors the RunRecipeResult shape of the
 * legacy TS executor so callers don't have to branch.
 */
export async function runRecipeViaGoose(
  supabase: SupabaseClient,
  _ctx: RunnerContext,
  args: RunRecipeViaGooseArgs,
): Promise<RunRecipeViaGooseResult> {
  const start = Date.now();

  // 1. Open run row (if not pre-allocated by the API).
  let runId: string;
  if (args.runId) {
    runId = args.runId;
    const upd = await supabase
      .from('ai_recipe_runs')
      .update({ status: 'running' })
      .eq('id', runId)
      .select('id')
      .maybeSingle();
    if (upd.error || !upd.data) {
      return earlyFail(supabase, args, '', `open_run_row_failed: ${upd.error?.message ?? 'row not found'}`, start);
    }
  } else {
    const insert = await supabase
      .from('ai_recipe_runs')
      .insert({
        recipe_id: args.recipeId ?? null,
        recipe_file_path: args.recipeFilePath ?? null,
        recipe_content_hash: args.recipe.content_hash,
        user_id: args.userId,
        use_case: args.useCase,
        host_kind: args.hostKind ?? null,
        host_id: args.hostId ?? null,
        params: args.params,
        status: 'running',
        steps: [],
        recipe_snapshot: args.recipe as unknown as Record<string, unknown>,
        sub_recipes_snapshot: snapshotSubs(args.subRecipes),
      })
      .select('id')
      .maybeSingle();
    if (insert.error || !insert.data) {
      return earlyFail(supabase, args, '', `open_run_row_failed: ${insert.error?.message ?? 'no row'}`, start);
    }
    runId = (insert.data as { id: string }).id;
  }

  // 2. Materialize recipe + sub-recipes into a tmpdir Goose can read.
  let workdir: string | null = null;
  let recipePath: string;
  try {
    workdir = await mkdtemp(join(osTmpdir(), `gatewaze-goose-${runId}-`));
    recipePath = await materializeRecipe(workdir, args.recipe, args.subRecipes);
  } catch (err) {
    const reason = `materialize_failed: ${err instanceof Error ? err.message : String(err)}`;
    await markRunFailed(supabase, runId, reason);
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    return { run_id: runId, status: 'failed', final_output: null, total_cost_micro_usd: 0, total_input_tokens: 0, total_output_tokens: 0, duration_ms: Date.now() - start, failure_reason: reason };
  }

  // 3. Spawn goose run. Provider creds come from the worker's env —
  //    no per-run config materialization needed since the platform
  //    already exports ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
  //    from secret stores. PATH is preserved so uvx/npx-resolved stdio
  //    MCP extensions can find their dependencies.
  const paramArgs: string[] = [];
  for (const [k, v] of Object.entries(args.params)) {
    paramArgs.push('--params', `${k}=${formatParam(v)}`);
  }
  const gooseArgs = [
    'run',
    '--recipe', recipePath,
    ...paramArgs,
    '--output-format', 'stream-json',
    '--quiet',
    '--no-session',
  ];

  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let stdoutBuf = '';
  let stderrBuf = '';
  let finalOutput: Record<string, unknown> | string | null = null;
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let provider: string | null = null;
  let model: string | null = null;
  let failureReason: string | undefined;

  try {
    child = spawn(GOOSE_BIN, gooseArgs, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Make Goose pick up the right model/provider. The platform's
        // per-use-case default routes through ANTHROPIC_API_KEY etc.
        // already in env; only the model selector is recipe-driven.
        GOOSE_PROVIDER: process.env.GOOSE_PROVIDER ?? '',
      },
    }) as ChildProcessByStdio<null, Readable, Readable>;
  } catch (err) {
    const reason = `goose_spawn_failed: ${err instanceof Error ? err.message : String(err)}`;
    await markRunFailed(supabase, runId, reason);
    await rm(workdir!, { recursive: true, force: true }).catch(() => undefined);
    return { run_id: runId, status: 'failed', final_output: null, total_cost_micro_usd: 0, total_input_tokens: 0, total_output_tokens: 0, duration_ms: Date.now() - start, failure_reason: reason };
  }

  const cancelTimer = setTimeout(() => {
    if (child && !child.killed) child.kill('SIGTERM');
    setTimeout(() => {
      if (child && !child.killed) child.kill('SIGKILL');
    }, CANCELLATION_GRACE_MS);
  }, MAX_RUN_DURATION_MS);

  try {
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', async (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.length === 0) continue;
        let event: GooseStreamEvent;
        try {
          event = JSON.parse(line) as GooseStreamEvent;
        } catch {
          continue; // Goose may emit non-JSON noise; skip
        }
        await handleEvent(event);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    async function handleEvent(event: GooseStreamEvent): Promise<void> {
      await args.onStreamEvent?.(event);

      if (event.type === 'Message') {
        // Drill into Message.content[] looking for a tool_request
        // whose name is the structured-output tool. The platform's
        // recipe v1 always names this 'submit_result' (the in-house
        // executor + the Goose runtime both follow Goose conventions).
        const msg = (event.message ?? event) as Record<string, unknown>;
        const content = Array.isArray((msg as { content?: unknown }).content)
          ? ((msg as { content: unknown[] }).content)
          : [];
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const it = item as Record<string, unknown>;
          // Goose's MessageContent enum tags vary by version; try
          // common shapes. We don't fail if neither matches — the
          // recipe just won't have structured output.
          const tr = (it.tool_request ?? it.toolRequest ?? it.ToolRequest) as Record<string, unknown> | undefined;
          if (!tr) continue;
          const toolName = (tr.name ?? (tr as { tool_name?: string }).tool_name) as string | undefined;
          if (toolName !== 'submit_result' && toolName !== 'submit_candidates') continue;
          // The arguments are the structured output.
          const argsField = (tr.arguments ?? tr.input ?? (tr as { params?: unknown }).params) as
            | Record<string, unknown>
            | string
            | undefined;
          if (typeof argsField === 'string') {
            try {
              finalOutput = JSON.parse(argsField) as Record<string, unknown>;
            } catch {
              finalOutput = argsField;
            }
          } else if (argsField && typeof argsField === 'object') {
            finalOutput = argsField as Record<string, unknown>;
          }
        }
      } else if (event.type === 'Complete') {
        const cmp = event as Record<string, unknown>;
        totalIn = numericOr(cmp.input_tokens ?? cmp.inputTokens, 0);
        totalOut = numericOr(cmp.output_tokens ?? cmp.outputTokens, 0);
        const totalTokens = numericOr(cmp.total_tokens ?? cmp.totalTokens, totalIn + totalOut);
        provider = typeof cmp.provider === 'string' ? cmp.provider : null;
        model = typeof cmp.model === 'string' ? cmp.model : null;
        // Goose doesn't ship a cost figure; we'd compute it via our
        // price book once provider+model are known. recordUsage()
        // does that lookup, so totalCost stays at 0 here — the row
        // it writes will carry the real micro_usd.
        void totalTokens;
      } else if (event.type === 'Error') {
        const errMsg = typeof event.error === 'string' ? event.error : JSON.stringify(event.error);
        failureReason = `goose_runtime_error: ${errMsg}`;
      }
    }

    const exitCode = await new Promise<number>((resolve) => {
      child!.on('exit', (code) => resolve(code ?? -1));
    });
    clearTimeout(cancelTimer);

    if (exitCode !== 0 && !failureReason) {
      failureReason = `goose_exit_${exitCode}: ${stderrBuf.slice(0, 1000)}`;
    }

    // Write a cost-ledger row using the per-run totals. The price
    // lookup happens inside recordUsage() against ai_model_prices, so
    // even though Goose doesn't tell us micro-USD directly, the ledger
    // ends up consistent with chat spend.
    if ((totalIn > 0 || totalOut > 0) && provider && model) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordUsage(supabase as any, {
          userId: args.userId,
          useCase: args.useCase,
          threadId: null,
          messageId: null,
          kind: 'llm',
          provider: provider as never,
          model,
          inputTokens: totalIn,
          outputTokens: totalOut,
          latencyMs: Date.now() - start,
          status: failureReason ? 'error' : 'ok',
          error: failureReason ?? null,
        });
      } catch {
        // Ledger failures don't break the run — operators can
        // reconcile from the Goose session log if needed.
      }
    }

    const status: RunRecipeViaGooseResult['status'] = failureReason ? 'failed' : 'complete';
    await supabase
      .from('ai_recipe_runs')
      .update({
        status,
        final_output: finalOutput,
        total_cost_micro_usd: totalCost,
        total_input_tokens: totalIn,
        total_output_tokens: totalOut,
        completed_at: new Date().toISOString(),
        failure_reason: failureReason ?? null,
      })
      .eq('id', runId);

    return {
      run_id: runId,
      status,
      final_output: finalOutput,
      total_cost_micro_usd: totalCost,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
      duration_ms: Date.now() - start,
      ...(failureReason && { failure_reason: failureReason }),
    };
  } catch (err) {
    const reason = `goose_exception: ${err instanceof Error ? err.message : String(err)}`;
    await markRunFailed(supabase, runId, reason);
    return { run_id: runId, status: 'failed', final_output: null, total_cost_micro_usd: 0, total_input_tokens: 0, total_output_tokens: 0, duration_ms: Date.now() - start, failure_reason: reason };
  } finally {
    clearTimeout(cancelTimer);
    if (child && !child.killed) child.kill('SIGTERM');
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Lay the parent recipe + every sub-recipe out under workdir so the
 * parent's `path: ../foo/recipe.yaml` references resolve. The
 * directory shape mirrors the source repo (recipes/<name>/recipe.yaml)
 * because that's what every sub_recipe path in the indexed recipes
 * uses today.
 */
async function materializeRecipe(
  workdir: string,
  recipe: ParsedRecipe,
  subRecipes: Map<string, ParsedRecipe>,
): Promise<string> {
  // Parent gets a top-level recipe.yaml. Sub-recipes go under their
  // declared relative paths (after normalising `../` against the
  // parent's implicit recipes/<name>/ location).
  const parentDir = join(workdir, 'recipes', 'parent');
  await mkdir(parentDir, { recursive: true });
  const parentPath = join(parentDir, 'recipe.yaml');
  await writeFile(parentPath, yamlDump(toGooseYaml(recipe)), 'utf-8');

  for (const [relPath, sub] of subRecipes) {
    // sub_recipes[].path is `../daily-briefing-research-sonnet/recipe.yaml`
    // relative to the PARENT'S recipe.yaml. Resolve against parentPath
    // so it lands in the same shape Goose expects.
    const absolute = resolvePath(parentDir, relPath);
    if (!absolute.startsWith(workdir + '/')) {
      throw new Error(`sub_recipe path escapes workdir: ${relPath}`);
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, yamlDump(toGooseYaml(sub)), 'utf-8');
  }
  return parentPath;
}

/**
 * Build the on-disk YAML for a recipe. The parsed shape carries
 * field names that match Goose's recipe schema almost 1-1; we just
 * rename `sub_recipes` → `sub_recipes` (already correct), drop
 * `content_hash` (parser-internal), and remap `parameters` /
 * `response_schema` to their wire forms.
 */
function toGooseYaml(recipe: ParsedRecipe): Record<string, unknown> {
  const out: Record<string, unknown> = {
    version: recipe.version ?? '1.0.0',
    title: recipe.title,
  };
  if (recipe.description) out.description = recipe.description;
  if (recipe.instructions) out.instructions = recipe.instructions;
  if (recipe.prompt) out.prompt = recipe.prompt;
  if (recipe.parameters && recipe.parameters.length > 0) out.parameters = recipe.parameters;
  if (recipe.response_schema) out.response = { json_schema: recipe.response_schema };
  if (recipe.settings && Object.keys(recipe.settings).length > 0) out.settings = recipe.settings;
  if (recipe.sub_recipes && recipe.sub_recipes.length > 0) out.sub_recipes = recipe.sub_recipes;
  if (recipe.extensions && recipe.extensions.length > 0) {
    // Extensions need their `raw` shape for Goose to load them.
    out.extensions = recipe.extensions.map((e) => e.raw ?? e);
  }
  return out;
}

function snapshotSubs(subs: Map<string, ParsedRecipe>): Record<string, ParsedRecipe> {
  const out: Record<string, ParsedRecipe> = {};
  for (const [k, v] of subs) out[k] = v;
  return out;
}

function numericOr(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

function formatParam(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

async function markRunFailed(supabase: SupabaseClient, runId: string, reason: string): Promise<void> {
  try {
    await supabase
      .from('ai_recipe_runs')
      .update({
        status: 'failed',
        failure_reason: reason,
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);
  } catch {
    // best-effort
  }
}

function earlyFail(
  _supabase: SupabaseClient,
  _args: RunRecipeViaGooseArgs,
  runId: string,
  reason: string,
  start: number,
): RunRecipeViaGooseResult {
  return {
    run_id: runId,
    status: 'failed',
    final_output: null,
    total_cost_micro_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    duration_ms: Date.now() - start,
    failure_reason: reason,
  };
}
