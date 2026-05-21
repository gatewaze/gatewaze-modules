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
  /**
   * External cancellation signal. When this aborts, the runner
   * SIGTERMs the goose subprocess (best-effort SIGKILL after the
   * cancellation grace window) and finishes with status='cancelled'.
   * Workers wire this to a CancelToken from subscribeCancel(...) so
   * the Jobs-tab Stop button propagates all the way down through
   * the goose CLI.
   */
  abortSignal?: AbortSignal;
  /**
   * Per-line callback for Goose's CLI debug log (only fires when
   * RUST_LOG=goose=* is set, which causes Goose to write structured
   * JSON-per-line events to $XDG_STATE_HOME/goose/logs/cli/...). Used
   * by daily-briefing's worker to surface sub-recipe tool calls
   * (web_search, fetch_url) to per-sub-recipe chat tabs in real time
   * — async-delegated sub-recipe stdout never reaches the parent's
   * stream-json output, so this is the only path that observes their
   * intermediate work.
   */
  onGooseLogEvent?: (event: GooseLogEvent) => Promise<void> | void;
}

/**
 * Parsed line from Goose's per-spawn CLI debug log. We extract just
 * the fields the demux needs; the rest of the JSON is preserved in
 * `raw` for callers that want to dig deeper.
 */
export interface GooseLogEvent {
  sessionId: string | null;
  message: string;
  toolName: string | null;
  toolArgs: Record<string, unknown> | null;
  /**
   * Tokens for a single Anthropic LLM call, parsed from the
   *   "Anthropic ACTUAL token counts from direct object: input=N, output=M, total=K"
   * debug line. Goose writes llm_request.*.jsonl files for some
   * sessions but not for Anthropic subagents — the daily-briefing
   * worker uses these events to attribute Sonnet usage that would
   * otherwise be lost. Null on every other line.
   */
  anthropicTokens: { input: number; output: number } | null;
  raw: Record<string, unknown>;
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

  // Substitute Goose's `computercontroller` builtin (browser automation,
  // shell access — not available inside the worker sandbox) with the
  // gatewaze-web-tools MCP. Recipes written for local-Goose use often
  // declare computercontroller to get web search + URL fetching; this
  // makes the same recipes run unchanged inside Gatewaze with the
  // platform's Serper/DDG search backend standing in.
  //
  // Returns the recipe / sub-recipes with computercontroller stripped
  // (so Goose doesn't try to load an extension that won't work) plus a
  // flag the MCP resolver checks to know it should auto-attach
  // gatewaze-web-tools even when allowed_web_tools is unset.
  const { recipe: recipeStripped, subRecipes: subRecipesStripped, substituted: ccSubstituted } =
    substituteComputercontroller(args.recipe, args.subRecipes);

  // Skill auto-loader: prepend the bodies of every declared / referenced
  // skill to each recipe's instructions before Goose sees them. Recipes
  // can declare skills two ways:
  //   1. Explicit `skills: [name, ...]` block (the preferred form)
  //   2. "Follow the X skill (auto-loaded by your runtime)" phrase
  //      inside instructions — backwards-compat with recipes authored
  //      against the in-house TS executor's skill auto-loader.
  // Both forms are unioned and resolved against ai_skills.body.
  const { recipe: recipeWithSkills, subRecipes: subRecipesWithSkills, skillsLoaded } =
    await autoloadSkills(supabase, recipeStripped, subRecipesStripped);
  if (skillsLoaded.length > 0) {
    _ctx.logger?.info?.('ai.recipe-goose.skills_autoloaded', {
      run_id: runId,
      skills: skillsLoaded,
    });
  }

  // 2. Materialize recipe + sub-recipes into a tmpdir Goose can read.
  let workdir: string | null = null;
  let recipePath: string;
  let subRecipePaths: string[] = [];
  try {
    workdir = await mkdtemp(join(osTmpdir(), `gatewaze-goose-${runId}-`));
    const materialized = await materializeRecipe(workdir, recipeWithSkills, subRecipesWithSkills);
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
      recipeExtensions: (recipeStripped.extensions ?? []) as any[],
      forceWebToolsBridge: ccSubstituted,
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
  // Pre-seed provider / model from the recipe's settings block. Goose
  // v1.34's `complete` stream event only emits total_tokens — no
  // provider or model split — so the wrapper would otherwise drop
  // every cost-ledger row for lack of these fields. Falling back to
  // what the recipe declared (settings.goose_provider /
  // settings.goose_model) is correct: that's literally what Goose
  // executed against, since it's how the spawn picked its provider.
  // Sub-recipe nested calls will override these fields if Goose ever
  // surfaces them in the stream.
  let provider: string | null = args.recipe.settings?.goose_provider ?? null;
  let model: string | null = args.recipe.settings?.goose_model ?? null;
  let failureReason: string | undefined;
  // spec-ai-mcp-extensions.md §Tool-call capture — each MCP tool call
  // surfaces as an ai_usage_events row tagged kind='mcp_tool' so the
  // cost ledger attributes per-server / per-tool spend the same way
  // it attributes kind='tool' web_search / fetch_url calls.
  // MCP tool-call telemetry with latency. toolRequest events stamp
  // started_at into pendingToolReqs keyed by tool-call id; toolResponse
  // events pair and compute latency_ms. Unmatched requests at end of
  // run get drained with latency = end-of-run timestamp.
  const mcpToolCalls: Array<{ server: string; tool: string; latencyMs: number }> = [];
  const pendingToolReqs = new Map<string, { server: string; tool: string; startedAt: number }>();

  // Per-spawn XDG_STATE_HOME so we can read Goose's per-LLM-request
  // logs after the run without interleaving with other concurrent
  // spawns. Goose writes one file per LLM call to
  // $XDG_STATE_HOME/goose/logs/llm_request.N.jsonl, each containing
  // the request (with model_config.model_name) + a final usage line
  // with input_tokens / output_tokens / cache token columns. We parse
  // these after the spawn to attribute spend per model — the only
  // path to per-call cost attribution in Goose v1.34, since the
  // stream-json `complete` event only carries an aggregate total.
  const xdgStateDir = await mkdtemp(join(osTmpdir(), `gatewaze-goose-xdg-${runId}-`));

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
        // Isolate Goose's state dir for this spawn — comment above the
        // xdgStateDir declaration explains why.
        XDG_STATE_HOME: xdgStateDir,
        // When a caller wired onGooseLogEvent, they need Goose's CLI
        // debug log file to exist — without RUST_LOG, Goose writes
        // nothing for the tailer to read and sub-recipe streaming
        // goes silent. Force goose=debug for the spawn (does not
        // affect the worker's own log level). Operators can still
        // override via process.env.RUST_LOG to widen the scope (e.g.
        // RUST_LOG='goose=trace,goose_cli=trace').
        ...(args.onGooseLogEvent && !process.env.RUST_LOG
          ? { RUST_LOG: 'goose=debug' }
          : {}),
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
    await rm(xdgStateDir, { recursive: true, force: true }).catch(() => undefined);
    return { run_id: runId, status: 'failed', final_output: null, total_cost_micro_usd: 0, total_input_tokens: 0, total_output_tokens: 0, duration_ms: Date.now() - start, failure_reason: reason };
  }

  const cancelTimer = setTimeout(() => {
    if (child && !child.killed) child.kill('SIGTERM');
    setTimeout(() => {
      if (child && !child.killed) child.kill('SIGKILL');
    }, CANCELLATION_GRACE_MS);
  }, MAX_RUN_DURATION_MS);

  // External cancel hook (Jobs-tab Stop → broadcastCancel pub/sub →
  // worker handler abort controller → here). SIGTERM the goose
  // subprocess and follow up with SIGKILL after the grace window if
  // it hasn't exited. failureReason gets stamped so the run's row
  // shows "cancelled by operator" instead of a bare non-zero exit.
  let cancelled = false;
  const onAbort = (): void => {
    if (cancelled) return;
    cancelled = true;
    failureReason = `cancelled_by_${(args.abortSignal as AbortSignal & { reason?: unknown })?.reason ?? 'operator'}`;
    if (child && !child.killed) child.kill('SIGTERM');
    setTimeout(() => {
      if (child && !child.killed) child.kill('SIGKILL');
    }, CANCELLATION_GRACE_MS);
  };
  if (args.abortSignal) {
    if (args.abortSignal.aborted) onAbort();
    else args.abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // CLI-log tailer. Goose writes one structured JSON-per-line debug
  // log per spawn at $XDG_STATE_HOME/goose/logs/cli/<date>/<ts>.log
  // when RUST_LOG=goose=* is set. The async-delegate path of
  // delegate(...) runs sub-recipes in internal sessions whose stdout
  // never reaches the parent's stream-json pipe, so this CLI log is
  // the only observation channel for intermediate sub-recipe tool
  // calls. Cancellation is fire-and-forget — the watch loop polls
  // an AbortSignal-style flag and exits cleanly when the goose
  // process terminates.
  const stopLogTail = { aborted: false };
  if (args.onGooseLogEvent) {
    void tailGooseCliLog(xdgStateDir, args.onGooseLogEvent, stopLogTail);
  }

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
          // Pair toolResponse → toolRequest for latency before the
          // toolRequest-only branch (the existing flow skipped non-
          // toolRequest items entirely).
          if (it.type === 'toolResponse') {
            const respId = (it as { id?: string }).id;
            if (typeof respId === 'string' && pendingToolReqs.has(respId)) {
              const req = pendingToolReqs.get(respId)!;
              pendingToolReqs.delete(respId);
              mcpToolCalls.push({
                server: req.server,
                tool: req.tool,
                latencyMs: Date.now() - req.startedAt,
              });
            }
            continue;
          }
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
          // through to no-op here. latency is computed later when
          // the matching toolResponse arrives.
          const toolCallId = (item as { id?: string }).id;
          if (typeof toolName === 'string' && toolName.includes('__') && typeof toolCallId === 'string') {
            const sep = toolName.indexOf('__');
            const ext = toolName.slice(0, sep);
            const tool = toolName.slice(sep + 2);
            if (loadedServerNames.includes(ext)) {
              pendingToolReqs.set(toolCallId, { server: ext, tool, startedAt: Date.now() });
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
        // Goose's complete event only includes provider/model on some
        // versions / providers. When absent, KEEP the pre-seeded
        // settings-derived values rather than nulling them out — the
        // wrapper still needs them for the cost-ledger row.
        if (typeof cmp.provider === 'string') provider = cmp.provider;
        if (typeof cmp.model === 'string') model = cmp.model;
      } else if (event.type === 'error') {
        const errMsg = typeof event.error === 'string' ? event.error : JSON.stringify(event.error);
        failureReason = `goose_runtime_error: ${errMsg}`;
      }
    }

    const exitCode = await new Promise<number>((resolve) => {
      child!.on('exit', (code) => resolve(code ?? -1));
    });
    clearTimeout(cancelTimer);
    stopLogTail.aborted = true;

    if (exitCode !== 0 && !failureReason) {
      failureReason = `goose_exit_${exitCode}: ${stderrBuf.slice(0, 1000)}`;
    }

    // Per-LLM-call cost attribution. Goose's stream-json `complete`
    // event only carries an aggregate total_tokens for the whole spawn
    // — useless when a recipe with sub-recipes mixes haiku (cheap) +
    // sonnet + gpt-5 in one run. Instead, read each per-call log file
    // from XDG_STATE_HOME/goose/logs/llm_request.N.jsonl and write
    // one ai_usage_events row per call with the actual provider/model
    // + accurate input/output/cache tokens. Aggregate cost on the
    // dashboard is unchanged; per-model attribution finally lines up.
    const perCallUsage = await extractPerCallUsage(xdgStateDir);
    if (perCallUsage.length > 0) {
      for (const u of perCallUsage) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await recordUsage(supabase as any, {
            userId: args.userId,
            useCase: args.useCase,
            threadId: null,
            messageId: null,
            kind: 'llm',
            provider: u.provider as never,
            model: u.model,
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cachedTokens: u.cache_read_input_tokens ?? 0,
            cacheCreationTokens: u.cache_write_input_tokens ?? 0,
            latencyMs: 0,
            status: failureReason ? 'error' : 'ok',
            error: failureReason ?? null,
          });
        } catch {
          // best-effort; cost ledger isn't critical for run completion
        }
      }
    } else if ((totalIn > 0 || totalOut > 0) && provider && model) {
      // Fallback: per-call log dir was empty (Goose didn't write logs
      // for some reason). Fall back to the legacy single-row attribution
      // off the complete event so spend isn't dropped entirely.
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
    // Drain any toolRequests that never paired with a toolResponse
    // (run terminated mid-tool). Latency = elapsed-since-request.
    for (const [, pending] of pendingToolReqs) {
      mcpToolCalls.push({
        server: pending.server,
        tool: pending.tool,
        latencyMs: Date.now() - pending.startedAt,
      });
    }
    pendingToolReqs.clear();

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
          latencyMs: call.latencyMs,
          status: 'ok',
          error: null,
        });
      } catch {
        // best-effort
      }
    }
    const status: RunRecipeViaGooseResult['status'] = cancelled
      ? 'cancelled'
      : failureReason ? 'failed' : 'complete';
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
    stopLogTail.aborted = true;
    if (child && !child.killed) child.kill('SIGTERM');
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    // GATEWAZE_GOOSE_KEEP_STATE=1 preserves the per-spawn XDG_STATE_HOME
    // dir so an operator can inspect Goose's per-LLM-request logs after
    // a run (used for debugging missing-usage attribution). Off by
    // default — the dir holds raw provider request/response payloads.
    if (process.env.GATEWAZE_GOOSE_KEEP_STATE !== '1') {
      await rm(xdgStateDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      _ctx.logger?.info?.('ai.recipe-goose.state_kept', { xdgStateDir, runId });
    }
  }
}

/**
 * Read Goose's per-LLM-request log files from XDG_STATE_HOME and
 * extract one usage record per LLM call.
 *
 * Goose v1.34 writes one file per call to
 * `<xdg_state_home>/goose/logs/llm_request.N.jsonl` (one numbered
 * sequence per spawn process; UUID-named files appear for some
 * orphaned or detached cases — we read them too). Each file is a
 * newline-delimited JSON stream where:
 *   - The first line carries the request with model_config.model_name
 *   - The last line containing a non-null `usage` object carries
 *     {input_tokens, output_tokens, cache_read_input_tokens?,
 *      cache_write_input_tokens?, total_tokens}
 *
 * Returns one entry per file with model + provider (inferred from
 * model id) + the four token columns. Empty array on any I/O failure.
 */
interface PerCallUsage {
  model: string;
  provider: 'anthropic' | 'openai' | 'gemini' | 'unknown';
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_write_input_tokens: number | null;
}
async function extractPerCallUsage(xdgStateDir: string): Promise<PerCallUsage[]> {
  const { readdir, readFile } = await import('node:fs/promises');
  const logsDir = `${xdgStateDir}/goose/logs`;
  let entries: string[] = [];
  try {
    entries = await readdir(logsDir);
  } catch {
    return [];
  }
  const out: PerCallUsage[] = [];
  for (const name of entries) {
    if (!name.startsWith('llm_request.') || !name.endsWith('.jsonl')) continue;
    let body: string;
    try {
      body = await readFile(`${logsDir}/${name}`, 'utf-8');
    } catch {
      continue;
    }
    const lines = body.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    // Parse the first line for model.
    let model = '';
    try {
      const first = JSON.parse(lines[0]!) as { model_config?: { model_name?: string }; input?: { model?: string } };
      model = first.model_config?.model_name ?? first.input?.model ?? '';
    } catch {/* skip */}
    if (!model) continue;
    // Walk backwards for the last usage line — Goose appends a final
    // {"data":null,"usage":{...}} after the streaming response ends.
    let usage: PerCallUsage | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!) as { usage?: Record<string, unknown> | null };
        const u = parsed.usage;
        if (u && typeof u === 'object') {
          const input = Number(u.input_tokens);
          const output = Number(u.output_tokens);
          if (Number.isFinite(input) && Number.isFinite(output)) {
            const cacheRead = u.cache_read_input_tokens;
            const cacheWrite = u.cache_write_input_tokens;
            usage = {
              model,
              provider: inferProviderFromModel(model),
              input_tokens: input,
              output_tokens: output,
              cache_read_input_tokens: typeof cacheRead === 'number' ? cacheRead : null,
              cache_write_input_tokens: typeof cacheWrite === 'number' ? cacheWrite : null,
            };
            break;
          }
        }
      } catch {/* skip non-JSON */}
    }
    if (usage) out.push(usage);
  }
  return out;
}

function inferProviderFromModel(modelId: string): PerCallUsage['provider'] {
  if (modelId.startsWith('claude') || modelId.includes('haiku') || modelId.includes('sonnet') || modelId.includes('opus')) {
    return 'anthropic';
  }
  if (modelId.startsWith('gpt') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) {
    return 'openai';
  }
  if (modelId.startsWith('gemini')) return 'gemini';
  return 'unknown';
}

/**
 * Tail Goose's per-spawn CLI debug log and emit one parsed event per
 * line through onLogEvent. The file lives at
 *   $XDG_STATE_HOME/goose/logs/cli/<yyyy-mm-dd>/<yyyymmdd_hhmmss>.log
 * and Goose only creates it once it actually starts running, so we
 * poll the date dir until the first file appears (typically <1s
 * after spawn). After that we hold an fd open and read appended
 * bytes on a 200ms tick — fs.watchFile is unreliable inside Docker
 * bind mounts, so we use plain stat-based polling for predictability.
 *
 * The loop terminates when `stop.aborted` flips true (set by the
 * parent's exit handler) or after MAX_RUN_DURATION_MS as a safety
 * net.
 *
 * Errors are swallowed — log-tailing is best-effort UI sugar; it
 * must never affect the run's success/failure status.
 */
async function tailGooseCliLog(
  xdgStateDir: string,
  onLogEvent: NonNullable<RunRecipeViaGooseArgs['onGooseLogEvent']>,
  stop: { aborted: boolean },
): Promise<void> {
  const { readdir, stat, open } = await import('node:fs/promises');
  const cliRoot = `${xdgStateDir}/goose/logs/cli`;
  const deadline = Date.now() + MAX_RUN_DURATION_MS;

  // Step 1: wait for the file to appear.
  let logPath: string | null = null;
  while (!stop.aborted && Date.now() < deadline && !logPath) {
    try {
      const dates = await readdir(cliRoot);
      for (const d of dates) {
        const files = await readdir(`${cliRoot}/${d}`);
        const matched = files.find((f) => f.endsWith('.log'));
        if (matched) {
          logPath = `${cliRoot}/${d}/${matched}`;
          break;
        }
      }
    } catch {/* dir not created yet */}
    if (!logPath) await sleep(200);
  }
  if (!logPath || stop.aborted) return;

  // Step 2: open the file and follow it. We track bytes-read; on
  // each tick we stat for size, read the delta, append to a buffer,
  // split on '\n', and emit each complete JSON line.
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(logPath, 'r');
  } catch {
    return;
  }
  let cursor = 0;
  let buf = '';
  try {
    while (!stop.aborted && Date.now() < deadline) {
      try {
        const s = await stat(logPath);
        if (s.size > cursor) {
          const chunkSize = s.size - cursor;
          const chunk = Buffer.alloc(chunkSize);
          await fd.read(chunk, 0, chunkSize, cursor);
          cursor = s.size;
          buf += chunk.toString('utf-8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim().length === 0) continue;
            try {
              const obj = JSON.parse(line) as Record<string, unknown>;
              const event = parseGooseLogLine(obj);
              if (event) {
                try {
                  await onLogEvent(event);
                } catch {/* user callback error; ignore */}
              }
            } catch {/* malformed JSON; skip */}
          }
        }
      } catch {/* stat / read transient error; retry */}
      await sleep(200);
    }
  } finally {
    try { await fd?.close(); } catch {/* ignore */}
  }
}

function parseGooseLogLine(obj: Record<string, unknown>): GooseLogEvent | null {
  const fields = obj.fields as Record<string, unknown> | undefined;
  const message = typeof fields?.message === 'string' ? fields.message : '';
  if (!message) return null;
  const span = obj.span as Record<string, unknown> | undefined;
  const sessionId = typeof span?.['session.id'] === 'string' ? (span['session.id'] as string) : null;

  // The events we care about all surface as
  //   fields.message = "WAITING_TOOL_START: <tool_name>"
  // plus span.input = '{"tool":"<tool_name>","arguments":{...}}'
  // We strip the tool name + arguments for the UI; everything else
  // (egress/permission/repetition inspector noise, ping events, etc.)
  // we leave as a passthrough so the demux can filter however it likes.
  let toolName: string | null = null;
  let toolArgs: Record<string, unknown> | null = null;
  if (message.startsWith('WAITING_TOOL_START:')) {
    toolName = message.slice('WAITING_TOOL_START:'.length).trim() || null;
    const rawInput = span?.input;
    if (typeof rawInput === 'string') {
      try {
        const parsed = JSON.parse(rawInput) as { tool?: string; arguments?: Record<string, unknown> };
        if (parsed.tool && !toolName) toolName = parsed.tool;
        if (parsed.arguments && typeof parsed.arguments === 'object') {
          toolArgs = parsed.arguments;
        }
      } catch {/* not JSON */}
    }
  }
  // "Anthropic ACTUAL token counts from direct object: input=29330, output=41, total=29371"
  // is emitted once per Anthropic LLM call when RUST_LOG=goose=debug.
  // We surface these so the worker handler can write usage rows for
  // sessions Goose's per-call file logger silently skips.
  let anthropicTokens: { input: number; output: number } | null = null;
  if (message.startsWith('Anthropic ACTUAL token counts')) {
    const m = message.match(/input=(\d+),\s*output=(\d+)/);
    if (m && m[1] && m[2]) {
      const input = Number(m[1]);
      const output = Number(m[2]);
      if (Number.isFinite(input) && Number.isFinite(output)) {
        anthropicTokens = { input, output };
      }
    }
  }
  return { sessionId, message, toolName, toolArgs, anthropicTokens, raw: obj };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Lay the parent recipe + every sub-recipe out under workdir so the
 * parent's `path: ../foo/recipe.yaml` references resolve. The
 * directory shape mirrors the source repo (recipes/<name>/recipe.yaml)
 * because that's what every sub_recipe path in the indexed recipes
 * uses today.
 */
/**
 * Skill auto-loader. Resolves every skill a recipe (or sub-recipe)
 * depends on against the ai_skills table and prepends the body to
 * the recipe's `instructions` before materialization. The Goose
 * spawn sees one merged instruction block — the model gets the same
 * context the in-house executor's "auto-loaded skill" feature used
 * to inject.
 *
 * Two declaration forms are unioned:
 *   1. `skills: [name, ...]` block (preferred). ParsedRecipe.skills
 *      carries this from parse-recipe.ts.
 *   2. "Follow the X skill (auto-loaded by your runtime)" phrase
 *      inside `instructions`. Captures X via regex so recipes
 *      authored against the old executor work without modification.
 *
 * Missing skills are best-effort: the run continues without that
 * skill's body, and the omission is returned for caller logging.
 * (We don't fail the run because that would surprise anyone whose
 * recipe references a skill that exists locally but not in the DB.)
 *
 * Frontmatter (--- ... ---) is stripped from each body before
 * injection; only the prose body reaches the model.
 */
const AUTOLOAD_PHRASE_RE = /the\s+([\w-]+)\s+skill\s*\(auto-loaded\s+by\s+your\s+runtime\)/gi;

async function autoloadSkills(
  supabase: SupabaseClient,
  recipe: ParsedRecipe,
  subRecipes: Map<string, ParsedRecipe>,
): Promise<{ recipe: ParsedRecipe; subRecipes: Map<string, ParsedRecipe>; skillsLoaded: string[] }> {
  // Union the skill names referenced across the parent + every sub-
  // recipe before issuing a single DB lookup. Most recipes share the
  // same skill so this collapses to one or two rows.
  const namesToResolve = new Set<string>();
  function collectFromRecipe(r: ParsedRecipe): void {
    if (Array.isArray(r.skills)) {
      for (const n of r.skills) namesToResolve.add(n);
    }
    if (typeof r.instructions === 'string') {
      for (const m of r.instructions.matchAll(AUTOLOAD_PHRASE_RE)) {
        if (typeof m[1] === 'string') namesToResolve.add(m[1]);
      }
    }
  }
  collectFromRecipe(recipe);
  for (const sub of subRecipes.values()) collectFromRecipe(sub);

  if (namesToResolve.size === 0) {
    return { recipe, subRecipes, skillsLoaded: [] };
  }

  // One read against ai_skills. We don't scope by source_id — multiple
  // sources rarely expose skills with the same name, and when they do
  // the first hit is the resolver's best guess. Authors can use the
  // explicit `skills: [name]` form and rely on operator-side source
  // ordering to disambiguate.
  const skillBodies = new Map<string, string>();
  const skillsLoaded: string[] = [];
  try {
    const res = await supabase
      .from('ai_skills')
      .select('name, body')
      .in('name', Array.from(namesToResolve));
    const rows = (res?.data as Array<{ name: string; body: string }> | null) ?? [];
    for (const row of rows) {
      if (typeof row.name !== 'string' || typeof row.body !== 'string') continue;
      if (skillBodies.has(row.name)) continue;
      skillBodies.set(row.name, stripFrontmatter(row.body));
      skillsLoaded.push(row.name);
    }
  } catch {
    // Best-effort: any DB error → no skills loaded, run continues.
    return { recipe, subRecipes, skillsLoaded: [] };
  }

  function inject(r: ParsedRecipe): ParsedRecipe {
    const declared = Array.isArray(r.skills) ? r.skills : [];
    const phraseMentions: string[] = typeof r.instructions === 'string'
      ? Array.from(r.instructions.matchAll(AUTOLOAD_PHRASE_RE), (m) => m[1] ?? '').filter((s) => s.length > 0)
      : [];
    const seen = new Set<string>();
    const bodies: string[] = [];
    for (const name of [...declared, ...phraseMentions]) {
      if (seen.has(name)) continue;
      seen.add(name);
      const body = skillBodies.get(name);
      if (typeof body === 'string' && body.length > 0) {
        bodies.push(`<!-- gatewaze-autoloaded-skill: ${name} -->\n${body.trim()}`);
      }
    }
    if (bodies.length === 0) return r;
    const block = bodies.join('\n\n---\n\n');
    return {
      ...r,
      instructions: `${block}\n\n---\n\n${r.instructions}`,
    };
  }

  const newRecipe = inject(recipe);
  const newSubs = new Map<string, ParsedRecipe>();
  for (const [k, v] of subRecipes) newSubs.set(k, inject(v));
  return { recipe: newRecipe, subRecipes: newSubs, skillsLoaded };
}

/** Strip a leading YAML frontmatter block (--- ... ---) from a markdown body. */
function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body;
  const end = body.indexOf('\n---', 3);
  if (end < 0) return body;
  return body.slice(end + 4).replace(/^\s*\n/, '');
}

/**
 * Detect and substitute Goose's `computercontroller` builtin
 * extension. Local Goose recipes often declare it to get a web-
 * search + URL-fetch surface, but the builtin needs Goose's host
 * environment (browser, shell) — not available inside the worker
 * sandbox. We strip it from the materialized recipe and signal the
 * MCP resolver to auto-attach gatewaze-web-tools (gatewaze_search)
 * as the search replacement.
 *
 * Returns the recipe + sub-recipes with the entries removed plus a
 * `substituted: true` flag whenever at least one occurrence was
 * detected anywhere in the tree.
 */
function substituteComputercontroller(
  recipe: ParsedRecipe,
  subRecipes: Map<string, ParsedRecipe>,
): { recipe: ParsedRecipe; subRecipes: Map<string, ParsedRecipe>; substituted: boolean } {
  let substituted = false;
  function stripFrom(r: ParsedRecipe): ParsedRecipe {
    if (!Array.isArray(r.extensions) || r.extensions.length === 0) return r;
    const kept = r.extensions.filter((e) => {
      const isCc = e?.type === 'builtin' && e?.name === 'computercontroller';
      if (isCc) substituted = true;
      return !isCc;
    });
    if (kept.length === r.extensions.length) return r;
    return { ...r, extensions: kept };
  }
  const newRecipe = stripFrom(recipe);
  const newSubs = new Map<string, ParsedRecipe>();
  for (const [k, v] of subRecipes) newSubs.set(k, stripFrom(v));
  return { recipe: newRecipe, subRecipes: newSubs, substituted };
}

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
  // Only emit settings keys with non-null values so we don't fill the
  // materialized yaml with `goose_provider: null` etc when the recipe
  // didn't actually declare them.
  if (recipe.settings) {
    const cleanedSettings: Record<string, unknown> = {};
    if (recipe.settings.goose_provider) cleanedSettings.goose_provider = recipe.settings.goose_provider;
    if (recipe.settings.goose_model) cleanedSettings.goose_model = recipe.settings.goose_model;
    if (recipe.settings.max_turns) cleanedSettings.max_turns = recipe.settings.max_turns;
    if (recipe.settings.max_tool_repetitions) cleanedSettings.max_tool_repetitions = recipe.settings.max_tool_repetitions;
    if (Object.keys(cleanedSettings).length > 0) out.settings = cleanedSettings;
  }
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
    /**
     * When true, attach gatewaze-web-tools (with gatewaze_search)
     * even if the use case's allowed_web_tools is empty. Set by the
     * caller when it stripped a `computercontroller` builtin from
     * the recipe — the MCP stands in as the web-search replacement.
     */
    forceWebToolsBridge?: boolean;
  },
): Promise<McpResolveResult> {
  // Web-tools bridge: bring ai_use_cases.allowed_web_tools into the
  // Goose spawn as a gatewaze-owned stdio MCP exposing gatewaze_search.
  // Same backend (Serper/DDG) the inline runChat path uses. When
  // forceWebToolsBridge is set, attach regardless of allowed_web_tools.
  const webToolsResolve = await resolveWebToolsExtension(
    supabase,
    args.useCaseId,
    { forceAttach: args.forceWebToolsBridge ?? false },
  );

  // 1. Recipe-declared extension names. Recipes that declare nothing
  //    still get the web-tools bridge if allowed_web_tools is non-empty;
  //    otherwise (no web tools either) the load is empty.
  const declaredNames = Array.from(new Set(
    args.recipeExtensions
      .map((e) => (typeof e.name === 'string' ? e.name : ((e.raw as { name?: string })?.name)))
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  ));

  if (declaredNames.length === 0) {
    return webToolsResolve;
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
    // spec-ai-mcp-extensions.md open question #4 — per-(use_case,
    // mcp_server) tool-call rate limit. Counts the trailing hour of
    // ai_usage_events(kind='mcp_tool'). If the cap is exceeded, exclude
    // the server from this run with a structured warning — the run
    // continues without that server's tools.
    {
      const { checkMcpRateLimit } = await import('../mcp/rate-limit.js');
      const decision = await checkMcpRateLimit(supabase, args.useCaseId, name);
      if (!decision.allowed) {
        warnings.push({
          code: 'mcp_rate_limited',
          server: name,
          details: `Trailing hour count ${decision.count} >= cap ${decision.cap}. Bump GATEWAZE_MCP_MAX_TOOL_CALLS_PER_HOUR or the per-use-case MCP_MAX_TOOL_CALLS_PER_HOUR override.`,
        });
        continue;
      }
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
      // spec-ai-mcp-extensions.md §Security §SSRF. Re-validate at
      // spawn time even though POST /admin/mcp-servers already
      // checked — DNS could have rebound between API write and the
      // current run.
      const { checkSsrfSafe } = await import('../secrets/ssrf-guard.js');
      const ssrf = await checkSsrfSafe(uri);
      if (!ssrf.ok) {
        warnings.push({
          code: 'mcp_ssrf_blocked',
          server: name,
          details: `URI ${uri} blocked at connect-time SSRF check: ${ssrf.reason}`,
        });
        continue;
      }
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

  // Merge the web-tools bridge into the final load so a recipe that
  // declares an MCP server AND the use case has allowed_web_tools both
  // load. Order matters only for stable warning ordering.
  return {
    flags: [...webToolsResolve.flags, ...flags],
    env: { ...webToolsResolve.env, ...env },
    warnings: [...webToolsResolve.warnings, ...warnings],
    loadedNames: [...webToolsResolve.loadedNames, ...loadedNames],
  };
}

/**
 * Bridge ai_use_cases.allowed_web_tools into the Goose spawn by
 * attaching the gatewaze-web-tools-mcp stdio script for the subset
 * of tools the Gatewaze MCP owns. Currently that's just
 * `gatewaze_search` — web_search and fetch_url come from the model
 * (Anthropic-native web_search) or Goose's developer builtin, not
 * from this MCP.
 *
 * Returns an empty load when allowed_web_tools doesn't include any
 * tool the MCP knows about, or when the use case row can't be read.
 */
const MCP_OWNED_TOOLS = new Set(['gatewaze_search']);

async function resolveWebToolsExtension(
  supabase: SupabaseClient,
  useCaseId: string,
  opts: { forceAttach?: boolean } = {},
): Promise<McpResolveResult> {
  let allowed: string[] = [];
  try {
    const res = await supabase
      .from('ai_use_cases')
      .select('allowed_web_tools')
      .eq('id', useCaseId)
      .maybeSingle();
    const row = (res.data as { allowed_web_tools?: string[] } | null) ?? null;
    allowed = Array.isArray(row?.allowed_web_tools) ? row!.allowed_web_tools.filter((t) => typeof t === 'string') : [];
  } catch {
    // forceAttach still wins even if the lookup failed.
    if (!opts.forceAttach) return { flags: [], env: {}, warnings: [], loadedNames: [] };
  }
  // Filter down to only the tools the Gatewaze MCP provides; if none
  // of the operator-enabled tools fall into that set, the MCP normally
  // wouldn't attach. forceAttach (set when the caller substituted
  // computercontroller) injects gatewaze_search regardless so the
  // recipe still gets a search surface.
  let mcpTools = allowed.filter((t) => MCP_OWNED_TOOLS.has(t));
  if (opts.forceAttach && !mcpTools.includes('gatewaze_search')) {
    mcpTools = [...mcpTools, 'gatewaze_search'];
  }
  if (mcpTools.length === 0) {
    return { flags: [], env: {}, warnings: [], loadedNames: [] };
  }

  // Resolve the launcher shim + the web-tools MCP script.
  const launcherPath = await resolveGatewazeGooseLauncherPath();
  const scriptPath = await resolveGatewazeWebToolsMcpPath();

  // Descriptor env (consumed by the launcher shim, same pattern as
  // operator-registered stdio servers). The shim spawn() the script
  // with shell:false so the args/env are not parsed by a shell.
  const descriptorEnvName = 'GATEWAZE_MCP_LAUNCH_DESCRIPTOR_GATEWAZE_WEB_TOOLS';
  // The script reads GATEWAZE_ALLOWED_WEB_TOOLS to filter its tools/
  // list, plus passthrough creds (SCRAPLING_FETCHER_URL/_TOKEN,
  // SERPER_API_KEY, GATEWAZE_SEARCH_BACKEND, GATEWAZE_FETCH_BASE_URL/
  // _API_KEY). The platform's worker already has these in the env —
  // we forward by reference so the MCP child inherits them.
  const perServerEnv: Record<string, string> = {
    GATEWAZE_ALLOWED_WEB_TOOLS: mcpTools.join(','),
  };
  for (const k of [
    'SCRAPLING_FETCHER_URL',
    'SCRAPLING_INTERNAL_TOKEN',
    'SERPER_API_KEY',
    'GATEWAZE_SEARCH_BACKEND',
    'GATEWAZE_FETCH_BASE_URL',
    'GATEWAZE_FETCH_API_KEY',
  ]) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length > 0) perServerEnv[k] = v;
  }
  const env: Record<string, string> = {
    [descriptorEnvName]: JSON.stringify({
      cmd: 'node',
      args: [scriptPath],
      env: perServerEnv,
    }),
  };
  return {
    flags: ['--with-extension', `node ${launcherPath} ${descriptorEnvName}`],
    env,
    warnings: [],
    loadedNames: ['gatewaze-web-tools'],
  };
}

/**
 * Locate scripts/gatewaze-web-tools-mcp.mjs at runtime. Same fallback
 * walk as the memory MCP — env override, walk up from this file,
 * baked /usr/local/bin symlink.
 */
async function resolveGatewazeWebToolsMcpPath(): Promise<string> {
  const envPath = process.env.GATEWAZE_WEB_TOOLS_MCP_PATH;
  if (envPath) return envPath;
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const { existsSync } = await import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const here = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath((globalThis as any).import?.meta?.url ?? `file://${process.cwd()}/`));
  const candidates = [
    resolve(here, '..', '..', 'scripts', 'gatewaze-web-tools-mcp.mjs'),
    resolve(here, '..', '..', '..', 'scripts', 'gatewaze-web-tools-mcp.mjs'),
    '/usr/local/bin/gatewaze-web-tools-mcp',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`gatewaze-web-tools-mcp script not found. Tried: ${candidates.join(', ')}. Set GATEWAZE_WEB_TOOLS_MCP_PATH to override.`);
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
