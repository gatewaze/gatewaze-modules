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
  let subRecipePaths: string[] = [];
  try {
    workdir = await mkdtemp(join(osTmpdir(), `gatewaze-goose-${runId}-`));
    const materialized = await materializeRecipe(workdir, args.recipe, args.subRecipes);
    recipePath = materialized.parentPath;
    subRecipePaths = materialized.subPaths;
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
  // Iteration ceilings — set EXPLICITLY rather than letting Goose's
  // default (1000) cap kick in. The dual-model daily-briefing recipe
  // observed 0 candidates at Goose's default because each sub-pass
  // exhausted Goose's tool-repetition budget before surfacing items
  // (research recipes legitimately call web_search / fetch_url many
  // times). Bump both ceilings and let the cost-ledger be the real
  // governance lever instead of a turn count.
  //
  // Tunables via env so an operator can dial them back without a
  // module redeploy if a runaway recipe ever burns cap.
  const maxTurns = Math.max(
    1,
    Number(process.env.GATEWAZE_GOOSE_MAX_TURNS ?? '500'),
  );
  const maxToolRepetitions = Math.max(
    1,
    Number(process.env.GATEWAZE_GOOSE_MAX_TOOL_REPETITIONS ?? '100'),
  );

  // Sub-recipes need to be passed as --sub-recipe flags explicitly —
  // Goose's `run --recipe parent.yaml` does NOT auto-traverse the
  // `sub_recipes:` array inside the YAML. Confirmed by observation:
  // a dual-model recipe ran with status=complete but the merger
  // produced 'no_candidates' because Sonnet + GPT-5 sub-passes were
  // never actually invoked. Pass each materialized sub-recipe path
  // so Goose registers them as runnable from the parent step.
  const subRecipeArgs: string[] = [];
  for (const subPath of subRecipePaths) {
    subRecipeArgs.push('--sub-recipe', subPath);
  }

  // spec-ai-mcp-extensions.md — resolve MCP extensions for this run.
  // Intersection of (recipe.extensions ∩ use_case.allowed_mcp_servers ∩ enabled).
  // Returns CLI flags + structured warnings + env merges for the spawn.
  let extensionFlags: string[] = [];
  let extensionEnv: Record<string, string> = {};
  let extensionWarnings: Array<Record<string, unknown>> = [];
  let loadedServerNames: string[] = [];
  try {
    const resolved = await resolveMcpExtensions(supabase, {
      useCaseId: args.useCase,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recipeExtensions: (args.recipe.extensions ?? []) as any[],
    });
    extensionFlags = resolved.flags;
    extensionEnv = resolved.env;
    extensionWarnings = resolved.warnings;
    loadedServerNames = resolved.loadedNames;
  } catch (err) {
    // MCP resolution failure (decrypt error, DB error) → fail the run
    // before spawn rather than silently dropping extensions.
    const reason = `mcp_load_failed: ${err instanceof Error ? err.message : String(err)}`;
    await markRunFailed(supabase, runId, reason, {
      code: 'mcp_load_failed',
      reason: 'mcp_resolve_failed',
      server_name: null,
      stderr_excerpt: reason.slice(0, 8000),
    });
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    return { run_id: runId, status: 'failed', final_output: null, total_cost_micro_usd: 0, total_input_tokens: 0, total_output_tokens: 0, duration_ms: Date.now() - start, failure_reason: reason };
  }

  const gooseArgs = [
    'run',
    '--recipe', recipePath,
    ...subRecipeArgs,
    ...paramArgs,
    ...extensionFlags,
    '--output-format', 'stream-json',
    '--quiet',
    '--no-session',
    '--max-turns', String(maxTurns),
    '--max-tool-repetitions', String(maxToolRepetitions),
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
  // spec-ai-mcp-extensions.md §Tool-call capture — each MCP tool call
  // surfaces as an ai_usage_events row tagged kind='mcp_tool' so the
  // cost ledger attributes per-server / per-tool spend the same way
  // it attributes kind='tool' web_search / fetch_url calls.
  const mcpToolCalls: Array<{ server: string; tool: string; ts: number }> = [];

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
        // Scope env for gatewaze-memory-mcp (substituted for the
        // `memory` builtin). The script reads these to decide which
        // (use_case, scope, thread_id?, user_id?) tuple to store/
        // retrieve under. Set unconditionally — the script only reads
        // them if invoked.
        GATEWAZE_USE_CASE: args.useCase,
        ...(args.hostKind === 'daily-briefing' && args.hostId
          ? {}                       // recipe runs hosted by daily-briefing don't have a thread id; falls through to use_case scope.
          : {}),
        ...(args.userId ? { GATEWAZE_USER_ID: args.userId } : {}),
        // spec-ai-mcp-extensions.md §Env injection — MCP server env
        // vars and bearer tokens (decrypted just-in-time, never logged).
        // Override anything in process.env so per-server creds win.
        ...extensionEnv,
        // Per-use-case Goose runtime overrides (round 7). Applied LAST
        // so use-case override > worker env > Goose default.
        ...(await resolveGooseOverrides(supabase, args.useCase)),
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

      // Goose's stream-json discriminators are lowercase: 'message',
      // 'complete', 'error', 'notification'. Each event's shape is
      // documented here against goose v1.34.x — re-validate when
      // bumping the GOOSE_VERSION pin (Renovate PR notes carry the
      // upstream changelog).
      if (event.type === 'message') {
        // Message events carry the assistant/user turn. Tool calls
        // live as content[].type === 'toolRequest' with a `toolCall`
        // object whose `.value.name` is the tool name and
        // `.value.arguments` is the structured payload.
        //
        // For recipes with a response.json_schema (every Gatewaze-
        // authored recipe does), Goose auto-injects a synthetic
        // `recipe__final_output` tool whose arguments match the
        // schema. That tool's call IS the structured output.
        const msg = (event.message ?? event) as Record<string, unknown>;
        const content = Array.isArray((msg as { content?: unknown }).content)
          ? ((msg as { content: unknown[] }).content)
          : [];
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const it = item as Record<string, unknown>;
          if (it.type !== 'toolRequest') continue;
          const toolCall = it.toolCall as Record<string, unknown> | undefined;
          if (!toolCall || typeof toolCall !== 'object') continue;
          const value = toolCall.value as Record<string, unknown> | undefined;
          if (!value || typeof value !== 'object') continue;
          const toolName = value.name;
          // Capture the recipe-final-output synthetic tool plus any
          // legacy in-house names we may have used during the
          // transition window. Anything else is either a generic tool
          // call (web_search, fetch_url) or an MCP-served tool that
          // we want in the cost-ledger as kind='mcp_tool'.
          if (
            toolName === 'recipe__final_output' ||
            toolName === 'submit_result' ||
            toolName === 'submit_candidates'
          ) {
            const argsField = value.arguments;
            if (typeof argsField === 'string') {
              try {
                finalOutput = JSON.parse(argsField) as Record<string, unknown>;
              } catch {
                finalOutput = argsField;
              }
            } else if (argsField && typeof argsField === 'object') {
              finalOutput = argsField as Record<string, unknown>;
            }
            continue;
          }
          // MCP tool calls follow Goose's namespacing convention:
          // <extension>__<tool>. If the prefix matches one of our
          // loaded server names, this is an MCP tool call worth
          // recording. recipe__ and other goose-internal tools fall
          // through to no-op here.
          if (typeof toolName === 'string' && toolName.includes('__')) {
            const sep = toolName.indexOf('__');
            const ext = toolName.slice(0, sep);
            const tool = toolName.slice(sep + 2);
            if (loadedServerNames.includes(ext)) {
              mcpToolCalls.push({ server: ext, tool, ts: Date.now() });
            }
          }
        }
      } else if (event.type === 'complete') {
        // v1.34 emits only `total_tokens` — no input/output split.
        // We attribute the whole figure to output_tokens for ledger
        // purposes so the cost compute through ai_model_prices reads
        // the same way an in-house chat run would (output is the
        // primary cost driver for completion-heavy recipes; the price
        // book's input rate just multiplies zero). When Goose grows a
        // split we can wire it through here without touching callers.
        const cmp = event as Record<string, unknown>;
        const total = numericOr(cmp.total_tokens ?? cmp.totalTokens, 0);
        totalIn = numericOr(cmp.input_tokens ?? cmp.inputTokens, 0);
        totalOut = numericOr(cmp.output_tokens ?? cmp.outputTokens, total - totalIn);
        if (totalOut < 0) totalOut = total;
        provider = typeof cmp.provider === 'string' ? cmp.provider : null;
        model = typeof cmp.model === 'string' ? cmp.model : null;
      } else if (event.type === 'error') {
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
        // best-effort; cost ledger isn't critical for run completion
      }
    }
    // MCP tool-call cost-ledger rows (one per call). Cost computed from
    // ai_model_prices when (provider=<server>, model=<tool>) is
    // registered; defaults to 0 otherwise.
    for (const call of mcpToolCalls) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordUsage(supabase as any, {
          userId: args.userId,
          useCase: args.useCase,
          threadId: null,
          messageId: null,
          kind: 'mcp_tool',
          provider: call.server as never,
          model: call.tool,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          status: 'ok',
          error: null,
        });
      } catch {
        // best-effort
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
        // spec-ai-mcp-extensions.md §Data Models §Run warnings.
        loaded_mcp_server_names: loadedServerNames,
        mcp_warnings: extensionWarnings,
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
): Promise<{ parentPath: string; subPaths: string[] }> {
  // Parent gets a top-level recipe.yaml. Sub-recipes go under their
  // declared relative paths (after normalising `../` against the
  // parent's implicit recipes/<name>/ location). Returned subPaths
  // are the absolute paths the caller passes to `--sub-recipe` flags
  // so Goose registers them as callable from the parent step.
  const parentDir = join(workdir, 'recipes', 'parent');
  await mkdir(parentDir, { recursive: true });
  const parentPath = join(parentDir, 'recipe.yaml');
  await writeFile(parentPath, yamlDump(toGooseYaml(recipe)), 'utf-8');

  const subPaths: string[] = [];
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
    subPaths.push(absolute);
  }
  return { parentPath, subPaths };
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

async function markRunFailed(
  supabase: SupabaseClient,
  runId: string,
  reason: string,
  failure_details?: Record<string, unknown>,
): Promise<void> {
  try {
    const update: Record<string, unknown> = {
      status: 'failed',
      failure_reason: reason,
      completed_at: new Date().toISOString(),
    };
    if (failure_details) update.failure_details = failure_details;
    await supabase
      .from('ai_recipe_runs')
      .update(update)
      .eq('id', runId);
  } catch {
    // best-effort
  }
}

// ─── MCP extension resolution ───────────────────────────────────────
//
// spec-ai-mcp-extensions.md §Runner / Goose CLI Integration §Extension
// resolution algorithm.
//
// Intersection of (recipe-declared ∩ use_case.allowed_mcp_servers ∩
// enabled servers). Returns CLI flags + decrypted env vars + structured
// warnings. Anything excluded surfaces as a warning, never silently
// dropped.

interface McpResolveResult {
  flags: string[];
  env: Record<string, string>;
  warnings: Array<Record<string, unknown>>;
  loadedNames: string[];
}

async function resolveMcpExtensions(
  supabase: SupabaseClient,
  args: {
    useCaseId: string;
    recipeExtensions: Array<{ name?: string; type?: string; raw?: Record<string, unknown> } & Record<string, unknown>>;
  },
): Promise<McpResolveResult> {
  // 1. Recipe-declared extension names. Recipes that declare nothing
  //    get an empty load — chat-path callers (§6 round 6) populate
  //    recipeExtensions from the use-case allowlist directly instead.
  const declaredNames = Array.from(new Set(
    args.recipeExtensions
      .map((e) => (typeof e.name === 'string' ? e.name : ((e.raw as { name?: string })?.name)))
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  ));

  if (declaredNames.length === 0) {
    return { flags: [], env: {}, warnings: [], loadedNames: [] };
  }

  // 2. Use-case allowlist.
  const allowRes = await supabase
    .from('ai_use_case_mcp_allowlist')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select('mcp_server_id, ai_mcp_servers(name, type, enabled, cmd, args, env_keys, envs_ciphertext, uri, bearer_token_ciphertext, headers, builtin_name)') as { data: Array<Record<string, unknown>> | null; error: { message: string } | null };
  // The join above filters by use_case_id but supabase-js requires the
  // .eq() call separately; doing it inline causes the typed select to
  // squash. Issue the eq:
  const allowed = await supabase
    .from('ai_use_case_mcp_allowlist')
    .select('mcp_server_id, ai_mcp_servers(name, type, enabled, cmd, args, env_keys, envs_ciphertext, uri, bearer_token_ciphertext, headers, builtin_name)')
    .eq('use_case_id', args.useCaseId);
  void allowRes;

  if (allowed.error) {
    throw new Error(`mcp_allowlist_load_failed: ${allowed.error.message}`);
  }
  const allowedRows = (allowed.data ?? []) as Array<{ mcp_server_id: string; ai_mcp_servers: Record<string, unknown> }>;
  const allowedByName = new Map<string, Record<string, unknown>>();
  for (const row of allowedRows) {
    const srv = row.ai_mcp_servers as { name?: string };
    if (typeof srv?.name === 'string') {
      allowedByName.set(srv.name, row.ai_mcp_servers);
    }
  }

  // 3. Intersect + classify each declared extension.
  const flags: string[] = [];
  const env: Record<string, string> = {};
  const warnings: Array<Record<string, unknown>> = [];
  const loadedNames: string[] = [];

  for (const name of declaredNames) {
    const server = allowedByName.get(name);
    if (!server) {
      warnings.push({ code: 'mcp_not_allowed', server: name, details: 'Server not in use_case.allowed_mcp_servers; add it via /admin/ai/mcp-allowlist.' });
      continue;
    }
    if (server.enabled === false) {
      warnings.push({ code: 'mcp_disabled', server: name, details: 'Server is registered + allowlisted but disabled.' });
      continue;
    }
    // Resolve to CLI flags + env.
    const type = server.type as string;
    if (type === 'stdio') {
      const cmd = server.cmd as string;
      const argList = (server.args as string[] | null) ?? [];
      // spec-ai-mcp-extensions.md §Stdio execution risk §Safe-spawn
      // adapter. Instead of passing a raw command string to Goose's
      // --with-extension (which may shell-parse it), we pass a single
      // invocation of the gatewaze-goose-launcher shim. The shim
      // reads the descriptor (cmd + args[] + env) from an env var
      // and spawns the actual MCP server via execve(cmd, args[]) with
      // shell:false. Goose's argv-parsing path never sees the operator-
      // supplied args.
      const launcherPath = await resolveGatewazeGooseLauncherPath();
      const descriptorEnvName = `GATEWAZE_MCP_LAUNCH_DESCRIPTOR_${name.toUpperCase().replace(/-/g, '_')}`;
      // Decrypt per-server env values first so we can bundle into descriptor.
      const perServerEnv: Record<string, string> = {};
      if (typeof server.envs_ciphertext === 'string' && server.envs_ciphertext.length > 0) {
        const { decryptSecret } = await import('../skills/secret-shim.js');
        const plaintext = decryptSecret(server.envs_ciphertext);
        if (plaintext != null) {
          try {
            const map = JSON.parse(plaintext) as Record<string, string>;
            for (const [k, v] of Object.entries(map)) {
              if (typeof v === 'string') perServerEnv[k] = v;
            }
          } catch {
            warnings.push({ code: 'mcp_envs_decrypt_parse_failed', server: name });
          }
        } else {
          warnings.push({ code: 'mcp_envs_decrypt_failed', server: name });
        }
      }
      const descriptor = { cmd, args: argList, env: perServerEnv };
      env[descriptorEnvName] = JSON.stringify(descriptor);
      flags.push('--with-extension', `node ${launcherPath} ${descriptorEnvName}`);
    } else if (type === 'streamable_http') {
      const uri = server.uri as string;
      flags.push('--with-streamable-http-extension', uri);
      if (typeof server.bearer_token_ciphertext === 'string' && server.bearer_token_ciphertext.length > 0) {
        const { decryptSecret } = await import('../skills/secret-shim.js');
        const plaintext = decryptSecret(server.bearer_token_ciphertext);
        if (plaintext != null) {
          try {
            const token = JSON.parse(plaintext) as string;
            const tokenEnvKey = `GOOSE_HTTP_EXTENSION_${name.toUpperCase().replace(/-/g, '_')}_TOKEN`;
            env[tokenEnvKey] = token;
          } catch {
            warnings.push({ code: 'mcp_bearer_decrypt_parse_failed', server: name });
          }
        } else {
          warnings.push({ code: 'mcp_bearer_decrypt_failed', server: name });
        }
      }
    } else if (type === 'builtin') {
      const builtinName = String(server.builtin_name ?? name);
      // spec-ai-mcp-extensions.md §Memory backing store §Substitution.
      // The `memory` builtin's local-FS storage is wrong for Gatewaze
      // (ephemeral, no admin visibility, no retention). Substitute the
      // gatewaze-memory-mcp stdio server which advertises the same
      // store_memory / retrieve_memory / list_memory tool surface but
      // persists to ai_memory. Goose namespaces stdio extensions by
      // their declared name, so as long as we spawn under name='memory'
      // the model sees the tools in the same namespace.
      if (builtinName === 'memory') {
        const scriptPath = await resolveGatewazeMemoryMcpPath();
        flags.push('--with-extension', `node ${scriptPath}`);
      } else {
        flags.push('--with-builtin', builtinName);
      }
    }
    loadedNames.push(name);
  }

  return { flags, env, warnings, loadedNames };
}

/**
 * spec-ai-mcp-extensions.md round 7 — load per-use-case Goose runtime
 * overrides. Returns an env map ready to merge onto the spawn. The DB
 * trigger validates the allowlist at write time so we don't re-check
 * here; the env map just stringifies whatever's stored.
 */
async function resolveGooseOverrides(
  supabase: SupabaseClient,
  useCaseId: string,
): Promise<Record<string, string>> {
  try {
    const res = await supabase
      .from('ai_use_cases')
      .select('goose_runtime_overrides')
      .eq('id', useCaseId)
      .maybeSingle();
    if (res.error || !res.data) return {};
    const overrides = ((res.data as { goose_runtime_overrides?: Record<string, unknown> }).goose_runtime_overrides) ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null) continue;
      out[k] = typeof v === 'string' ? v : String(v);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Locate scripts/gatewaze-memory-mcp.mjs at runtime. Tries (in order):
 *   1. GATEWAZE_MEMORY_MCP_PATH env var (operator override).
 *   2. Resolution relative to this compiled JS file — works for the
 *      production module-host path and the dev tsx-watch path.
 *   3. A baked /usr/local/bin/gatewaze-memory-mcp symlink (future).
 *
 * Throws if none resolve — callers should never silently fall through
 * to Goose's local-FS memory builtin (the whole point of the
 * substitution is to avoid that).
 */
async function resolveGatewazeGooseLauncherPath(): Promise<string> {
  const envPath = process.env.GATEWAZE_GOOSE_LAUNCHER_PATH;
  if (envPath) return envPath;
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const { existsSync } = await import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const here = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath((globalThis as any).import?.meta?.url ?? `file://${process.cwd()}/`));
  const candidates = [
    resolve(here, '..', '..', 'scripts', 'gatewaze-goose-launcher.mjs'),
    resolve(here, '..', '..', '..', 'scripts', 'gatewaze-goose-launcher.mjs'),
    '/usr/local/bin/gatewaze-goose-launcher',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`gatewaze-goose-launcher script not found. Tried: ${candidates.join(', ')}. Set GATEWAZE_GOOSE_LAUNCHER_PATH to override.`);
}

async function resolveGatewazeMemoryMcpPath(): Promise<string> {
  const envPath = process.env.GATEWAZE_MEMORY_MCP_PATH;
  if (envPath) return envPath;
  // Walk up from this file's directory to find scripts/gatewaze-memory-mcp.mjs.
  // run-recipe-goose.ts compiles to .../modules/ai/lib/recipes/run-recipe-goose.js,
  // so the script lives at ../../scripts/gatewaze-memory-mcp.mjs.
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const { existsSync } = await import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const here = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath((globalThis as any).import?.meta?.url ?? `file://${process.cwd()}/`));
  const candidates = [
    resolve(here, '..', '..', 'scripts', 'gatewaze-memory-mcp.mjs'),
    resolve(here, '..', '..', '..', 'scripts', 'gatewaze-memory-mcp.mjs'),
    '/usr/local/bin/gatewaze-memory-mcp',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`gatewaze-memory-mcp script not found. Tried: ${candidates.join(', ')}. Set GATEWAZE_MEMORY_MCP_PATH to override.`);
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
