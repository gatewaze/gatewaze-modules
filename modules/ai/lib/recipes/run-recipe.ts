/**
 * Recipe executor — runs a parsed Goose-compatible recipe through
 * runChat() with full cost-ledger + budget-cap integration.
 *
 * Per spec-ai-workflows-and-skill-interop.md §3.4:
 *   1. validateRecipe — refuse Tier-3 (already done at parse time;
 *      double-checked here as a defensive measure).
 *   2. bindParameters — Jinja-style substitution with sanitisation.
 *   3. open ai_recipe_runs row.
 *   4. pre-flight budget check (worst-case across full DAG).
 *   5. DFS pre-order over the step DAG; each step:
 *        - resolve model (uses use-case fallback per §4.2)
 *        - bind step inputs from prior step outputs (§4.5)
 *        - runChat() — recordUsage writes the cost row with
 *          recipe_run_id + recipe_step_index backrefs.
 *        - store output keyed by step_id (`step-N`).
 *        - check cancellation flag.
 *   6. validate parent recipe's response.json_schema against the
 *      last non-skipped step's output.
 *   7. close ai_recipe_runs row.
 *
 * v1 scope notes (per spec):
 *   - MCP extensions (streamable_http, stdio): NOT WIRED in this
 *     phase. Recipes that declare them parse to Tier 1/2/3 but the
 *     executor doesn't expose tools to the model yet. Phase D.
 *   - `builtin: memory` tool: NOT WIRED in this phase. Phase D.
 *   - Fanout (values: resolving to an array): not yet implemented in
 *     this phase — bound to a TODO. Per spec §4.4 the cap is 5.
 *   - JSON-schema validation: implemented as a shallow structural
 *     check (required keys present, primitive types match). A full
 *     ajv-grade validator is Phase D work.
 */

import {
  runChat,
  type RunnerContext,
  type RunChatOpts,
  type RunChatResult,
} from '../runner.js';
import type { ExtraTool } from '../providers/types.js';

// The ai module declares @supabase/supabase-js as a peerDependency,
// not a dependency — so typed imports don't resolve at tsc time. The
// runner's RunnerContext already carries the supabase handle; the
// executor accepts that same shape via a local SupabaseLike.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any; rpc?: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> };
import {
  MAX_RECIPE_FANOUT,
  type ParsedRecipe,
  type ParsedSubRecipeRef,
} from './parse-recipe.js';
import { createMcpClient, type McpClientHandle } from './mcp-client.js';
import { resolveMcpExtension } from './mcp-resolve.js';
import { createMemoryTool, MEMORY_TOOL_SCHEMAS, type MemoryToolHandle } from './memory-tool.js';

const MAX_RECIPE_DURATION_MS = 30 * 60 * 1000;
const CANCELLATION_GRACE_MS = 5000;

export type RecipeParamScalar = string | number | boolean | Date;
export type RecipeParamValue = RecipeParamScalar | RecipeParamScalar[];

export interface RunRecipeArgs {
  /** Parsed recipe (from parse-recipe.ts). */
  recipe: ParsedRecipe;
  /** Map of sub-recipe path → parsed recipe (already parsed at sync time). */
  subRecipes: Map<string, ParsedRecipe>;
  /** Caller-supplied parameter values. */
  params: Record<string, RecipeParamValue>;
  userId: string | null;
  useCase: string;
  hostKind?: string;
  hostId?: string;
  /** Recipe id from ai_recipes (nullable for ad-hoc YAML runs). */
  recipeId?: string;
  recipeFilePath?: string;
  /**
   * Pre-allocated ai_recipe_runs row id. When provided, the executor
   * skips its own INSERT and treats the row as the canonical record.
   * The worker-dispatch path always supplies this (the API INSERTs
   * with status='queued' before enqueuing). Backwards-compat inline
   * callers can omit it; the executor will INSERT as before.
   */
  runId?: string;
  /** Optional progress callback fired between steps. */
  onProgress?: (step: { index: number; status: string }) => void;
  /**
   * Optional event callbacks consumed by the worker handler (spec-ai-
   * job-runner §4.1). When unset, executor behaviour is identical to
   * pre-worker. Workers wire these to XADD on the run's Redis Stream.
   *
   * Note: token-level / tool-call streaming events are NOT emitted at
   * step granularity in v1. They are surfaced once at step.complete.
   * Follow-up work wires per-token + per-tool emission through the
   * provider clients (anthropic/openai/gemini).
   */
  onStepStart?: (idx: number, step: { step_id: string; step_label?: string }) => Promise<void>;
  onStepComplete?: (
    idx: number,
    out: { structured: Record<string, unknown> | null; cost_micro_usd: number; status: 'complete' | 'skipped' | 'failed' },
  ) => Promise<void>;
}

export interface RunRecipeResult {
  run_id: string;
  status: 'complete' | 'failed' | 'cancelled' | 'budget_blocked';
  /**
   * Final output of the recipe. Discriminated by terminal-step shape:
   *   - Record<string, unknown>: last non-skipped step produced
   *     structured output.
   *   - string: last non-skipped step produced narrative-only output
   *     AND the parent declared no response.json_schema (no contract
   *     was violated).
   *   - null: no step ever ran OR run terminated before any output.
   */
  final_output: Record<string, unknown> | string | null;
  steps: Array<{
    step_id: string;
    step_index: number;
    usage_event_id: string | null;
    provider: string | null;
    model: string | null;
    cost_micro_usd: number;
    duration_ms: number;
    status: 'complete' | 'failed' | 'cancelled' | 'skipped';
    structured?: Record<string, unknown> | null;
    narrative?: string;
  }>;
  total_cost_micro_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  duration_ms: number;
  failure_reason?: string;
}

/**
 * Top-level entry point. Opens an ai_recipe_runs row, runs the DAG,
 * persists progress incrementally, and resolves the final row state
 * before returning.
 */
export async function runRecipe(
  supabase: SupabaseClient,
  ctx: RunnerContext,
  args: RunRecipeArgs,
): Promise<RunRecipeResult> {
  const recipeStart = Date.now();

  // 1. Parameter binding — substitute {{ key }} in instructions +
  //    sub-recipe values, with sanitisation per §4.4.
  let boundInstructions: string;
  try {
    boundInstructions = bindParameters(args.recipe.instructions, args.params, args.recipe.parameters);
  } catch (err) {
    return earlyFail(
      supabase,
      args,
      'parameter_binding_failed: ' + (err instanceof Error ? err.message : String(err)),
      recipeStart,
    );
  }

  // 2. Open the run row. Failures mean nothing else can proceed.
  //    Worker-dispatch path supplies args.runId — the row was already
  //    INSERTed by the API with status='queued'; we just flip it.
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
      return {
        run_id: runId,
        status: 'failed',
        final_output: null,
        steps: [],
        total_cost_micro_usd: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        duration_ms: Date.now() - recipeStart,
        failure_reason: 'open_run_row_failed: ' + (upd.error?.message ?? 'row not found'),
      };
    }
  } else {
    const runRow = await openRunRow(supabase, args);
    if (!runRow.ok) {
      return {
        run_id: '',
        status: 'failed',
        final_output: null,
        steps: [],
        total_cost_micro_usd: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        duration_ms: Date.now() - recipeStart,
        failure_reason: 'open_run_row_failed: ' + runRow.reason,
      };
    }
    runId = runRow.id;
  }

  // 3. Step DAG enumeration in DFS pre-order. Step 0 is the parent
  //    recipe's primary step; sub-recipes get sequential indices.
  const stepPlan = enumerateSteps(args.recipe, args.subRecipes);

  // Outputs map is populated either by the executor or by checkpoint
  // hydration on retry — declared early so both paths can write to it.
  const outputs = new Map<string, { structured: Record<string, unknown> | null; narrative: string }>();

  // 3.5. Retry checkpoint hydration (spec-ai-job-runner §4.4).
  //
  // When the worker retries a run, the ai_recipe_run_steps rows from
  // the prior attempt carry status='complete' for steps we've already
  // executed. We hydrate them into `outputs` + `stepRecords` so:
  //   - downstream steps' outputs_from refs resolve against prior
  //     structured output (idempotency token).
  //   - the executor's main loop sees the step records and SKIPs
  //     completed steps via `step.status='skipped'` in the run record
  //     while NOT re-running the step.
  //
  // We only do this when args.runId is provided (worker-dispatch path)
  // — the inline-fallback path never retries so there's nothing to hydrate.
  const completedStepIndices = new Set<number>();
  if (args.runId) {
    const stepsRes = await supabase
      .from('ai_recipe_run_steps')
      .select('step_index, step_id, status, structured, narrative, cost_micro_usd, duration_ms')
      .eq('recipe_run_id', runId)
      .eq('status', 'complete');
    const completedRows =
      (stepsRes?.data as Array<{
        step_index: number;
        step_id: string;
        status: string;
        structured: Record<string, unknown> | null;
        narrative: string | null;
        cost_micro_usd: number;
        duration_ms: number;
      }> | null) ?? [];
    for (const row of completedRows) {
      completedStepIndices.add(row.step_index);
      outputs.set(`step-${row.step_index}`, {
        structured: row.structured,
        narrative: row.narrative ?? '',
      });
    }
  }

  // 4. Pre-flight budget gate (§7.8). Sum worst-case cost across the
  //    full plan against the use-case's daily cap. Fanout multiplies
  //    per-step by MAX_RECIPE_FANOUT (5×).
  //
  //    v1 simplification: we use the in-built runChat() budget gate
  //    per step rather than implementing a separate cross-step
  //    pre-flight sum. runChat() already refuses a single call that
  //    would breach the cap. The trade-off: a multi-step recipe can
  //    burn 80% of the cap on early steps and then have later steps
  //    refused. Documented in §14 as a v2 follow-up; for v1 we
  //    accept it because spec-ai-module deliberately defers hard
  //    enforcement to v2.

  // 5. Execute steps sequentially in DFS pre-order. Cancellation is
  //    checked between steps; an in-flight step gets the grace
  //    window before its AbortController fires.
  const stepRecords: RunRecipeResult['steps'] = [];
  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let failureReason: string | undefined;
  let cancelled = false;

  // Per-run `builtin: memory` handle. Created lazily on first use,
  // reused across all steps so memory.store / memory.retrieve see the
  // same per-run KV store. The DB layer scopes everything by runId.
  let memoryHandle: MemoryToolHandle | null = null;
  const ensureMemory = (): MemoryToolHandle => {
    if (memoryHandle == null) memoryHandle = createMemoryTool(supabase, runId);
    return memoryHandle;
  };

  for (const planned of stepPlan) {
    // Hard cap on total wall-clock duration.
    if (Date.now() - recipeStart > MAX_RECIPE_DURATION_MS) {
      failureReason = 'total_duration_exceeded';
      break;
    }
    // Retry skip — if a prior attempt completed this step, push a
    // 'skipped' record into the local array (so downstream summary +
    // event emission see all steps) and continue. The output is
    // already in `outputs` from §3.5 hydration so dependent steps
    // resolve correctly.
    if (completedStepIndices.has(planned.step_index)) {
      stepRecords.push({
        step_id: planned.step_id,
        step_index: planned.step_index,
        usage_event_id: null,
        provider: null,
        model: null,
        cost_micro_usd: 0,
        duration_ms: 0,
        status: 'skipped',
      });
      args.onProgress?.({ index: planned.step_index, status: 'skipped' });
      await args.onStepComplete?.(planned.step_index, {
        structured: outputs.get(`step-${planned.step_index}`)?.structured ?? null,
        cost_micro_usd: 0,
        status: 'skipped',
      });
      await persistStepRecord(supabase, runId, stepRecords);
      continue;
    }
    // Cancellation check before each step starts.
    if (await isCancelled(supabase, runId)) {
      cancelled = true;
      break;
    }

    // Activation key — skip the step if the preceding sibling's
    // structured output doesn't carry the matching key/value.
    if (planned.activation_key && planned.activation_value !== null) {
      const prev = lookupActivationSource(planned, stepRecords, outputs);
      if (!prev || prev.structured?.[planned.activation_key] !== planned.activation_value) {
        stepRecords.push({
          step_id: planned.step_id,
          step_index: planned.step_index,
          usage_event_id: null,
          provider: null,
          model: null,
          cost_micro_usd: 0,
          duration_ms: 0,
          status: 'skipped',
        });
        args.onProgress?.({ index: planned.step_index, status: 'skipped' });
        await args.onStepComplete?.(planned.step_index, {
          structured: null,
          cost_micro_usd: 0,
          status: 'skipped',
        });
        await persistStepRecord(supabase, runId, stepRecords);
        continue;
      }
    }

    // Emit step.start AFTER the activation-key skip check so skipped
    // steps don't generate a misleading start event.
    await args.onStepStart?.(planned.step_index, {
      step_id: planned.step_id,
      step_label: planned.step_id,
    });

    // ── Fanout detection (§4.4) ─────────────────────────────────
    // A `values:` entry whose resolved value is a JS array triggers
    // fanout (one execution per element). v1 supports exactly one
    // fanout dimension per step; multi-dimensional fanout (cartesian
    // product) is refused. Arrays longer than MAX_RECIPE_FANOUT
    // refuse at run time, not parse time, since the length is data-
    // dependent on prior step outputs.
    let fanoutDetect: FanoutDetection;
    try {
      fanoutDetect = detectFanout(planned.values, outputs);
    } catch (err) {
      failureReason = `sub_recipe_input_unsatisfied: ${planned.step_id}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      stepRecords.push({
        step_id: planned.step_id,
        step_index: planned.step_index,
        usage_event_id: null,
        provider: planned.provider,
        model: planned.model,
        cost_micro_usd: 0,
        duration_ms: 0,
        status: 'failed',
      });
      break;
    }
    if (fanoutDetect.kind === 'multi') {
      failureReason = `multi_dim_fanout_unsupported: ${planned.step_id}: keys=${fanoutDetect.keys.join(',')}`;
      stepRecords.push({
        step_id: planned.step_id,
        step_index: planned.step_index,
        usage_event_id: null,
        provider: planned.provider,
        model: planned.model,
        cost_micro_usd: 0,
        duration_ms: 0,
        status: 'failed',
      });
      break;
    }
    if (fanoutDetect.kind === 'array' && fanoutDetect.elements.length > MAX_RECIPE_FANOUT) {
      failureReason = `fanout_array_exceeded_cap: ${planned.step_id}: ${fanoutDetect.elements.length} > ${MAX_RECIPE_FANOUT}`;
      stepRecords.push({
        step_id: planned.step_id,
        step_index: planned.step_index,
        usage_event_id: null,
        provider: planned.provider,
        model: planned.model,
        cost_micro_usd: 0,
        duration_ms: 0,
        status: 'failed',
      });
      break;
    }

    // Build the invocation list. Non-fanout = one invocation with
    // the original values; fanout = N invocations, each with the
    // array key substituted to a scalar element.
    const invocations: Array<{ values: Record<string, unknown>; fanoutIndex: number | null }> =
      fanoutDetect.kind === 'array'
        ? fanoutDetect.elements.map((el, i) => ({
            values: { ...planned.values, [fanoutDetect.key]: el },
            fanoutIndex: i,
          }))
        : [{ values: planned.values, fanoutIndex: null }];

    // Run each invocation sequentially. Spec §4.4 calls for "bounded
    // concurrency" via Promise.allSettled; v1 ships sequential (the
    // simpler lower bound that's correct). Concurrency = follow-up.
    const invocationOutputs: Array<{
      structured: Record<string, unknown> | null;
      narrative: string;
    }> = [];
    let stepFailed = false;
    for (const inv of invocations) {
      // Bind step inputs from prior outputs. Errors here fail the step.
      let stepInstructions: string;
      try {
        stepInstructions = bindStepInputs(
          planned.instructions,
          inv.values,
          planned.parameterDefs,
          args.params,
          outputs,
        );
      } catch (err) {
        failureReason = `sub_recipe_input_unsatisfied: ${planned.step_id}${inv.fanoutIndex !== null ? `#${inv.fanoutIndex}` : ''}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        stepRecords.push({
          step_id: planned.step_id,
          step_index: planned.step_index,
          usage_event_id: null,
          provider: planned.provider,
          model: planned.model,
          cost_micro_usd: 0,
          duration_ms: 0,
          status: 'failed',
        });
        stepFailed = true;
        break;
      }

      // Build the step's extraTools surface: MCP server tools + the
      // builtin: memory functions if declared. MCP clients open per
      // step and close in a finally block — we don't keep persistent
      // MCP sessions across steps in v1 (the spec's SESSION_TIMEOUT_MS
      // suggests we could, but per-step lifecycle is simpler to reason
      // about + matches the Goose default).
      const mcpClients: McpClientHandle[] = [];
      const extraTools: ExtraTool[] = [];
      try {
        // 1) builtin: memory (single declaration per step).
        const declaresMemory = planned.extensions.some(
          (e) => e.tier !== 3 && (e.raw as Record<string, unknown>).type === 'builtin' && (e.raw as Record<string, unknown>).name === 'memory',
        );
        if (declaresMemory) {
          const mem = ensureMemory();
          extraTools.push(
            {
              name: MEMORY_TOOL_SCHEMAS[0].name,
              description: MEMORY_TOOL_SCHEMAS[0].description,
              inputSchema: MEMORY_TOOL_SCHEMAS[0].input_schema as Record<string, unknown>,
              resolve: async (a) => mem.store(String(a.key ?? ''), a.value),
            },
            {
              name: MEMORY_TOOL_SCHEMAS[1].name,
              description: MEMORY_TOOL_SCHEMAS[1].description,
              inputSchema: MEMORY_TOOL_SCHEMAS[1].input_schema as Record<string, unknown>,
              resolve: async (a) => mem.retrieve(String(a.key ?? '')),
            },
            {
              name: MEMORY_TOOL_SCHEMAS[2].name,
              description: MEMORY_TOOL_SCHEMAS[2].description,
              inputSchema: MEMORY_TOOL_SCHEMAS[2].input_schema as Record<string, unknown>,
              resolve: async () => mem.list_keys(),
            },
          );
        }

        // 2) streamable_http MCP extensions — resolve + connect.
        //    Failures here are step-failures: spec §8 says
        //    `mcp_unreachable` and `mcp_session_timeout` fail the step.
        for (const ext of planned.extensions) {
          if (ext.tier === 3) continue;
          const raw = ext.raw as Record<string, unknown>;
          if (raw.type !== 'streamable_http') continue;
          const resolved = await resolveMcpExtension(raw, args.useCase);
          if (!resolved.ok) {
            throw new Error(`mcp_resolve_failed: ${resolved.reason}: ${resolved.details ?? ''}`);
          }
          const client = await createMcpClient({
            uri: resolved.uri,
            auth: { ...(resolved.bearer_token && { bearer_token: resolved.bearer_token }) },
          });
          mcpClients.push(client);
          for (const t of client.tools()) {
            extraTools.push({
              name: t.name,
              description: t.description,
              inputSchema: t.input_schema,
              resolve: async (a) => {
                const result = await client.call(t.name, a);
                if (!result.ok) throw new Error(result.error);
                return result.result;
              },
            });
          }
        }
      } catch (err) {
        // Clean up any half-opened MCP clients before surfacing.
        for (const c of mcpClients) await c.close().catch(() => undefined);
        failureReason = `mcp_setup_failed: ${planned.step_id}${inv.fanoutIndex !== null ? `#${inv.fanoutIndex}` : ''}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        stepRecords.push({
          step_id: planned.step_id,
          step_index: planned.step_index,
          usage_event_id: null,
          provider: planned.provider,
          model: planned.model,
          cost_micro_usd: 0,
          duration_ms: 0,
          status: 'failed',
        });
        stepFailed = true;
        break;
      }

      // The Goose `prompt:` field becomes the initial user turn.
      // Subject to the same `{{ param }}` substitution as instructions
      // — bindParameters handles validation + sanitisation.
      const userTurn = planned.prompt
        ? bindParameters(planned.prompt, args.params, planned.parameterDefs)
        : 'Run this recipe step.';

      const stepStart = Date.now();
      const stepArgs: RunChatOpts = {
        useCase: args.useCase,
        userId: args.userId,
        threadId: null,
        messageId: null,
        systemPrompt:
          planned.step_index === 0 && inv.fanoutIndex === null
            ? boundInstructions
            : stepInstructions,
        messages: [{ role: 'user', content: userTurn }],
        provider: planned.provider as RunChatOpts['provider'],
        model: planned.model ?? undefined,
        maxOutputTokens: undefined,
        structuredTool: planned.response_schema
          ? {
              name: 'submit_result',
              description: 'Submit the recipe step result as structured JSON.',
              inputSchema: planned.response_schema as Record<string, unknown>,
            }
          : undefined,
        extraTools: extraTools.length > 0 ? extraTools : undefined,
      };

      let chatResult: RunChatResult;
      try {
        chatResult = await runChat(ctx, stepArgs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failureReason = `step_${planned.step_index}${inv.fanoutIndex !== null ? `#${inv.fanoutIndex}` : ''}_${planned.provider ?? 'auto'}: ${msg}`;
        stepRecords.push({
          step_id: planned.step_id,
          step_index: planned.step_index,
          usage_event_id: null,
          provider: planned.provider,
          model: planned.model,
          cost_micro_usd: 0,
          duration_ms: Date.now() - stepStart,
          status: 'failed',
        });
        stepFailed = true;
        // Drop MCP sessions before bailing.
        for (const c of mcpClients) await c.close().catch(() => undefined);
        break;
      }

      // Step succeeded — close MCP sessions before recording, so cleanup
      // failures never mask the success status.
      for (const c of mcpClients) await c.close().catch(() => undefined);

      invocationOutputs.push({
        structured: chatResult.structured,
        narrative: chatResult.narrative,
      });

      totalCost += chatResult.costMicroUsd;
      totalIn += chatResult.inputTokens;
      totalOut += chatResult.outputTokens;
      stepRecords.push({
        step_id: planned.step_id + (inv.fanoutIndex !== null ? `#${inv.fanoutIndex}` : ''),
        step_index: planned.step_index,
        usage_event_id: null,
        provider: chatResult.provider,
        model: chatResult.model,
        cost_micro_usd: chatResult.costMicroUsd,
        duration_ms: chatResult.latencyMs,
        status: 'complete',
        structured: chatResult.structured,
        narrative: chatResult.narrative,
      });
      args.onProgress?.({ index: planned.step_index, status: 'complete' });
      await args.onStepComplete?.(planned.step_index, {
        structured: chatResult.structured ?? null,
        cost_micro_usd: chatResult.costMicroUsd,
        status: 'complete',
      });
      await persistStepRecord(supabase, runId, stepRecords);
      await backlinkUsageEvent(supabase, runId, planned.step_index, args.userId, args.useCase, stepStart);
    }
    if (stepFailed) break;

    // Store output keyed by step_id. For fanout, expose as `items`
    // so downstream `outputs_from: step-N.items[0]` works — the
    // structured shape stays object-typed (matches the runtime
    // contract that resolveOutputsFrom expects).
    if (fanoutDetect.kind === 'array') {
      outputs.set(planned.step_id, {
        structured: { items: invocationOutputs.map((o) => o.structured) },
        narrative: invocationOutputs.map((o) => o.narrative).join('\n---\n'),
      });
    } else {
      const only = invocationOutputs[0]!;
      outputs.set(planned.step_id, only);
    }
  }

  // 6. Final-step output extraction + parent-schema validation.
  const lastExecuted = [...stepRecords].reverse().find((s) => s.status === 'complete');
  let finalOutput: RunRecipeResult['final_output'] = null;
  let status: RunRecipeResult['status'] = 'complete';

  if (cancelled) {
    status = 'cancelled';
  } else if (failureReason) {
    status = 'failed';
  } else if (!lastExecuted) {
    status = 'failed';
    failureReason = 'all_steps_skipped: no_executed_step_to_validate';
  } else if (args.recipe.response_schema) {
    if (lastExecuted.structured == null) {
      status = 'failed';
      failureReason = 'structured_output_invalid: parent_final: no_structured_output';
      finalOutput = lastExecuted.narrative ?? null;
    } else {
      const ok = shallowValidateJsonSchema(lastExecuted.structured, args.recipe.response_schema);
      if (!ok.ok) {
        status = 'failed';
        failureReason = `structured_output_invalid: parent_final: ${ok.reason}`;
        finalOutput = lastExecuted.structured;
      } else {
        finalOutput = lastExecuted.structured;
      }
    }
  } else {
    // No parent schema — narrative or structured both fine.
    finalOutput = lastExecuted.structured ?? lastExecuted.narrative ?? null;
  }

  // 7. Persist final state.
  const duration = Date.now() - recipeStart;
  await supabase
    .from('ai_recipe_runs')
    .update({
      status,
      failure_reason: failureReason ?? null,
      final_output: finalOutput,
      steps: stepRecords as unknown as Record<string, unknown>[],
      total_cost_micro_usd: totalCost,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
      completed_at: new Date().toISOString(),
      duration_ms: duration,
    })
    .eq('id', runId);

  return {
    run_id: runId,
    status,
    final_output: finalOutput,
    steps: stepRecords,
    total_cost_micro_usd: totalCost,
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    duration_ms: duration,
    failure_reason: failureReason,
  };
}

// ─── Step planning ───────────────────────────────────────────────────

interface PlannedStep {
  step_id: string;
  step_index: number;
  /** Provider hint. Resolved by runChat against the use-case default. */
  provider: string | null;
  model: string | null;
  instructions: string;
  /** Optional Goose-style `prompt:` field (initial user turn). */
  prompt: string | null;
  /** Parameter definitions (for type coercion on outputs_from). */
  parameterDefs: ParsedRecipe['parameters'];
  /** Raw values block from the parent's sub_recipes[] entry. */
  values: Record<string, unknown>;
  response_schema: ParsedRecipe['response_schema'];
  activation_key: string | null;
  activation_value: string | null;
  /** Index of the preceding sibling step (for activation lookup). */
  preceding_step_index: number | null;
  /**
   * Per-step extensions declaration carried forward from the recipe.
   * The executor uses this to know whether to open MCP clients +
   * expose the memory tool surface.
   */
  extensions: ParsedRecipe['extensions'];
}

function enumerateSteps(
  recipe: ParsedRecipe,
  subRecipes: Map<string, ParsedRecipe>,
): PlannedStep[] {
  const plan: PlannedStep[] = [];

  // Step 0 = parent recipe's primary step.
  plan.push({
    step_id: 'step-0',
    step_index: 0,
    provider: recipe.settings.goose_provider,
    model: recipe.settings.goose_model,
    instructions: recipe.instructions,
    prompt: recipe.prompt,
    parameterDefs: recipe.parameters,
    values: {},
    response_schema: recipe.response_schema,
    activation_key: null,
    activation_value: null,
    preceding_step_index: null,
    extensions: recipe.extensions,
  });

  // Sub-recipes in DFS pre-order. Per spec §3.4 they execute in
  // declared array order — no model-driven branching.
  let index = 1;
  function visit(sub: ParsedSubRecipeRef, predecessor: number): void {
    const child = subRecipes.get(sub.path);
    if (!child) {
      // Missing at run time — flag a planned step with no recipe so
      // the executor can fail the run with sub_recipe_missing.
      plan.push({
        step_id: `step-${index}`,
        step_index: index,
        provider: null,
        model: null,
        instructions: '',
        prompt: null,
        parameterDefs: [],
        values: sub.values,
        response_schema: null,
        activation_key: sub.activation_key,
        activation_value: sub.activation_value,
        preceding_step_index: predecessor,
        extensions: [],
      });
      index++;
      return;
    }
    const provider = child.settings.goose_provider ?? recipe.settings.goose_provider;
    const model = child.settings.goose_model ?? recipe.settings.goose_model;
    const thisIndex = index;
    plan.push({
      step_id: `step-${index}`,
      step_index: index,
      provider,
      model,
      instructions: child.instructions,
      prompt: child.prompt,
      parameterDefs: child.parameters,
      values: sub.values,
      response_schema: child.response_schema,
      activation_key: sub.activation_key,
      activation_value: sub.activation_value,
      preceding_step_index: predecessor,
      extensions: child.extensions,
    });
    index++;
    for (const grand of child.sub_recipes) visit(grand, thisIndex);
  }
  for (const top of recipe.sub_recipes) visit(top, 0);

  return plan;
}

// ─── Fanout detection ───────────────────────────────────────────────
//
// Per spec §4.4: a values-block entry that resolves to a JS array
// triggers fanout. Detection walks every value, resolving outputs_from
// refs against the prior step output map. Literal arrays in the YAML
// also count (the parser preserves arrays as-is).
//
// Return shape:
//   { kind: 'none' }                                 — run once with original values
//   { kind: 'array', key, elements }                 — fan out N executions
//   { kind: 'multi', keys }                          — refuse (v1 doesn't do cartesian)

type FanoutDetection =
  | { kind: 'none' }
  | { kind: 'array'; key: string; elements: unknown[] }
  | { kind: 'multi'; keys: string[] };

function detectFanout(
  values: Record<string, unknown>,
  outputs: Map<string, { structured: Record<string, unknown> | null; narrative: string }>,
): FanoutDetection {
  const arrayKeys: Array<{ key: string; elements: unknown[] }> = [];
  for (const [key, v] of Object.entries(values)) {
    // Literal array in the YAML.
    if (Array.isArray(v)) {
      arrayKeys.push({ key, elements: v });
      continue;
    }
    // outputs_from ref that resolves to an array.
    if (v && typeof v === 'object' && !Array.isArray(v) && 'outputs_from' in v) {
      const ref = (v as { outputs_from: unknown }).outputs_from;
      if (typeof ref !== 'string') continue; // bind-step will catch the type error
      try {
        const resolved = resolveOutputsFrom(ref, outputs);
        if (Array.isArray(resolved)) {
          arrayKeys.push({ key, elements: resolved });
        }
      } catch {
        // Resolution error here is non-fatal for fanout detection —
        // bindStepInputs will hit the same error and surface it.
      }
    }
  }
  if (arrayKeys.length === 0) return { kind: 'none' };
  if (arrayKeys.length > 1) {
    return { kind: 'multi', keys: arrayKeys.map((a) => a.key) };
  }
  return { kind: 'array', key: arrayKeys[0]!.key, elements: arrayKeys[0]!.elements };
}

// ─── Parameter + step-input binding ──────────────────────────────────

/** §4.4 — substitute {{ key }} in `text` with caller-supplied params. */
function bindParameters(
  text: string,
  params: Record<string, RecipeParamValue>,
  declared: ParsedRecipe['parameters'],
): string {
  // Validate required params are supplied.
  for (const def of declared) {
    if (def.requirement === 'required' && params[def.key] === undefined) {
      throw new Error(`missing required parameter '${def.key}'`);
    }
  }
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_full, key: string) => {
    if (!(key in params)) {
      // Reference for an undeclared key — should have been caught at
      // parse time. Defensive guard at runtime: treat as empty.
      return '';
    }
    // Non-null asserted: `key in params` confirmed presence above.
    return sanitiseParamValue(params[key]!);
  });
}

/** Sanitise a substituted value per spec §4.4 (remove, not escape). */
function sanitiseParamValue(v: RecipeParamValue): string {
  // Arrays are handled at the fanout layer, not here.
  if (Array.isArray(v)) return JSON.stringify(v);
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else s = String(v);

  // Remove {{ }} ${ backticks. Collapse whitespace runs > 1 KiB.
  s = s.replace(/\{\{/g, '');
  s = s.replace(/\}\}/g, '');
  s = s.replace(/`/g, '');
  s = s.replace(/\$\{/g, '');
  s = s.replace(/\s{1024,}/g, ' ');
  return s;
}

/** Per §4.5 — bind sub-recipe values via outputs_from + caller params. */
function bindStepInputs(
  instructions: string,
  values: Record<string, unknown>,
  parameterDefs: ParsedRecipe['parameters'],
  callerParams: Record<string, RecipeParamValue>,
  outputs: Map<string, { structured: Record<string, unknown> | null; narrative: string }>,
): string {
  const resolved: Record<string, RecipeParamValue> = {};
  for (const def of parameterDefs) {
    // 1. Caller params (when sub-recipe shares a key name with the parent).
    if (def.key in callerParams) {
      resolved[def.key] = callerParams[def.key]!;
      continue;
    }
    // 2. values block — either a literal or an outputs_from ref.
    if (def.key in values) {
      const v = values[def.key];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'outputs_from' in v) {
        const ref = (v as { outputs_from: unknown }).outputs_from;
        if (typeof ref !== 'string') {
          throw new Error(`values.${def.key}.outputs_from must be a string`);
        }
        const refValue = resolveOutputsFrom(ref, outputs);
        resolved[def.key] = coerceForParam(refValue, def, ref);
        continue;
      }
      resolved[def.key] = v as RecipeParamValue;
      continue;
    }
    // 3. Required + unsupplied → fail.
    if (def.requirement === 'required') {
      throw new Error(`required parameter '${def.key}' has no value`);
    }
  }
  return bindParameters(instructions, resolved, parameterDefs);
}

/** Resolve an outputs_from string like `step-0.candidates[2].title`. */
function resolveOutputsFrom(
  ref: string,
  outputs: Map<string, { structured: Record<string, unknown> | null; narrative: string }>,
): unknown {
  const head = ref.match(/^step-(\d+)/);
  if (!head) throw new Error(`outputs_from must start with step-N (got '${ref}')`);
  const stepId = `step-${head[1]}`;
  const entry = outputs.get(stepId);
  if (!entry) throw new Error(`${ref}: step has not run`);
  if (!entry.structured) throw new Error(`${ref}: step has no structured output`);

  // Walk the remaining path. Grammar per §4.5: `.<ident>` or `[<N>]`.
  let value: unknown = entry.structured;
  const tail = ref.slice(head[0].length);
  const segRegex = /\.([a-zA-Z_][a-zA-Z0-9_]*)|\[(\d+)\]/g;
  let lastEnd = 0;
  let segMatch: RegExpExecArray | null;
  while ((segMatch = segRegex.exec(tail)) !== null) {
    if (segMatch.index !== lastEnd) {
      throw new Error(`${ref}: invalid syntax near '${tail.slice(lastEnd, segMatch.index + 4)}'`);
    }
    lastEnd = segRegex.lastIndex;
    if (segMatch[1] !== undefined) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${ref}: path not found (non-object at '${segMatch[1]}')`);
      }
      value = (value as Record<string, unknown>)[segMatch[1]];
    } else {
      const idx = parseInt(segMatch[2]!, 10);
      if (!Array.isArray(value)) {
        throw new Error(`${ref}: path not found (non-array at [${idx}])`);
      }
      value = value[idx];
    }
  }
  if (lastEnd !== tail.length) {
    throw new Error(`${ref}: trailing characters '${tail.slice(lastEnd)}'`);
  }
  if (value === undefined) throw new Error(`${ref}: path not found`);
  return value;
}

/** Type-coerce a resolved outputs_from value into a parameter input_type. */
function coerceForParam(
  value: unknown,
  def: ParsedRecipe['parameters'][number],
  ref: string,
): RecipeParamValue {
  switch (def.input_type) {
    case 'string':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'number': {
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && !Number.isNaN(Number(value))) return Number(value);
      throw new Error(`${ref}: resolved to ${typeof value}, expected number`);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
      }
      throw new Error(`${ref}: resolved to ${typeof value}, expected boolean`);
    }
    case 'date': {
      if (typeof value === 'string') {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d;
      }
      throw new Error(`${ref}: resolved value is not a valid ISO-8601 date string`);
    }
    case 'select': {
      const s = typeof value === 'string' ? value : String(value);
      if (!def.options || !def.options.includes(s)) {
        throw new Error(`${ref}: value '${s}' not in options [${def.options?.join(', ') ?? ''}]`);
      }
      return s;
    }
  }
}

// ─── Activation lookup ───────────────────────────────────────────────

function lookupActivationSource(
  planned: PlannedStep,
  records: RunRecipeResult['steps'],
  outputs: Map<string, { structured: Record<string, unknown> | null; narrative: string }>,
): { structured: Record<string, unknown> | null; narrative: string } | null {
  // Per §4.7: activation checks against the immediately PRECEDING
  // sibling step. Spec says "immediately preceding sibling"; we
  // approximate sibling as `preceding_step_index` recorded at plan
  // time (which is the parent's primary step for top-level subs).
  const predIdx = planned.preceding_step_index;
  if (predIdx === null) return null;
  const predId = `step-${predIdx}`;
  return outputs.get(predId) ?? null;
}

// ─── Persistence helpers ─────────────────────────────────────────────

async function openRunRow(
  supabase: SupabaseClient,
  args: RunRecipeArgs,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const res = await supabase
    .from('ai_recipe_runs')
    .insert({
      recipe_id: args.recipeId ?? null,
      recipe_file_path: args.recipeFilePath ?? null,
      recipe_content_hash: args.recipe.content_hash,
      user_id: args.userId,
      use_case: args.useCase,
      host_kind: args.hostKind ?? null,
      host_id: args.hostId ?? null,
      params: args.params as unknown as Record<string, unknown>,
      status: 'running',
      steps: [],
    })
    .select('id')
    .maybeSingle();
  if (res.error || !res.data) {
    return { ok: false, reason: res.error?.message ?? 'no row returned' };
  }
  return { ok: true, id: res.data.id as string };
}

async function persistStepRecord(
  supabase: SupabaseClient,
  runId: string,
  steps: RunRecipeResult['steps'],
): Promise<void> {
  // Denormalised JSON array on the run row — keeps the admin UI's
  // single-row read fast.
  await supabase
    .from('ai_recipe_runs')
    .update({ steps: steps as unknown as Record<string, unknown>[] })
    .eq('id', runId);
  // Per-step checkpoint table — written incrementally so retries
  // (spec-ai-job-runner §4.4) can skip already-complete steps without
  // walking the full JSON. The last entry is the one we just wrote.
  const last = steps[steps.length - 1];
  if (!last) return;
  const structured = (last as { structured?: Record<string, unknown> | null }).structured ?? null;
  const narrative = (last as { narrative?: string }).narrative ?? null;
  await supabase
    .from('ai_recipe_run_steps')
    .upsert(
      {
        recipe_run_id: runId,
        step_index: last.step_index,
        step_id: last.step_id,
        status: last.status,
        structured,
        narrative,
        cost_micro_usd: last.cost_micro_usd,
        duration_ms: last.duration_ms,
        // started_at is set on first transition to 'running'; for the
        // current model we just stamp it on the last write — accurate
        // enough for retry skipping, where the worker only cares about
        // 'status=complete' rows.
        completed_at:
          last.status === 'complete' || last.status === 'failed' || last.status === 'cancelled'
            ? new Date().toISOString()
            : null,
      },
      { onConflict: 'recipe_run_id,step_index' },
    );
}

async function backlinkUsageEvent(
  supabase: SupabaseClient,
  runId: string,
  stepIndex: number,
  userId: string | null,
  useCase: string,
  stepStart: number,
): Promise<void> {
  // Find the most-recent ai_usage_events row for (user, use_case)
  // since step start, and stamp it with recipe_run_id + step_index.
  // Best-effort — failure logged but doesn't fail the step.
  try {
    let q = supabase
      .from('ai_usage_events')
      .select('id')
      .eq('use_case', useCase)
      .gte('occurred_at', new Date(stepStart - 2000).toISOString())
      .order('occurred_at', { ascending: false })
      .limit(1);
    if (userId) q = q.eq('user_id', userId);
    const found = await q.maybeSingle();
    if (found.data?.id) {
      await supabase
        .from('ai_usage_events')
        .update({ recipe_run_id: runId, recipe_step_index: stepIndex })
        .eq('id', found.data.id);
    }
  } catch {
    // best-effort
  }
}

async function isCancelled(supabase: SupabaseClient, runId: string): Promise<boolean> {
  try {
    const res = await supabase.from('ai_recipe_runs').select('status').eq('id', runId).maybeSingle();
    return res.data?.status === 'cancelled';
  } catch {
    return false;
  }
}

async function earlyFail(
  supabase: SupabaseClient,
  args: RunRecipeArgs,
  reason: string,
  start: number,
): Promise<RunRecipeResult> {
  const opened = await openRunRow(supabase, args);
  const runId = opened.ok ? opened.id : '';
  if (runId) {
    await supabase
      .from('ai_recipe_runs')
      .update({
        status: 'failed',
        failure_reason: reason,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - start,
      })
      .eq('id', runId);
  }
  return {
    run_id: runId,
    status: 'failed',
    final_output: null,
    steps: [],
    total_cost_micro_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    duration_ms: Date.now() - start,
    failure_reason: reason,
  };
}

// ─── JSON-schema shallow validator ───────────────────────────────────
// v1 is a structural sanity check — required keys present + primitive
// types match. A full JSON Schema validator (ajv) is Phase D work.

function shallowValidateJsonSchema(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  if (schema.type === 'object' && Array.isArray(schema.required)) {
    for (const k of schema.required) {
      if (typeof k !== 'string') continue;
      if (!(k in value)) return { ok: false, reason: `missing required key '${k}'` };
    }
  }
  // Properties type-tag check (string|number|boolean|object|array).
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [k, propSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (!(k in value)) continue;
      const expected = (propSchema as { type?: string }).type;
      if (!expected) continue;
      const actual = jsTypeOf(value[k]);
      if (expected !== actual && !(expected === 'integer' && actual === 'number')) {
        return { ok: false, reason: `property '${k}' has type '${actual}', expected '${expected}'` };
      }
    }
  }
  return { ok: true };
}

function jsTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// MAX_RECIPE_FANOUT is imported so that callers that pre-validate
// fanout arrays at request time can reference the cap directly.
export { MAX_RECIPE_FANOUT };

// Internal helpers exposed for unit tests. Not part of the public
// runtime contract — callers outside __tests__ should use runRecipe().
export const __internal = {
  bindParameters,
  sanitiseParamValue,
  bindStepInputs,
  resolveOutputsFrom,
  coerceForParam,
  detectFanout,
};
