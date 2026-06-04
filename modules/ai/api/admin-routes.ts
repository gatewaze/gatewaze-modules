/**
 * Admin REST endpoints for the AI module.
 *
 * Mounted under /api/modules/ai/admin/* (the platform's
 * /api/modules/<id> prefix is JWT-gated).
 *
 * Endpoint catalogue (per spec §8):
 *   - Thread CRUD                /admin/threads*
 *   - Use-case registry          /admin/use-cases*
 *   - Credentials                /admin/credentials/*
 *   - Usage / cost dashboard     /admin/usage/*
 *   - Model picker support       /admin/use-cases/:id/models
 *
 * All non-2xx responses share the platform's standard error envelope:
 *   { "error": "snake_case_code", "message": "..." }
 *
 * Mass-assignment guards: every write goes through pick* fields
 * allowlists. See gatewaze-production-readiness security boundaries.
 */

import type { Request, Response, Router } from 'express';

import { runChat } from '../lib/runner.js';
import type { KnownProvider } from '../lib/providers/types.js';
import { sumSpentMicroUsd } from '../lib/cost.js';
import { parseRecipe, type ParsedRecipe } from '../lib/recipes/parse-recipe.js';
import { runRecipe } from '../lib/recipes/run-recipe.js';
import { resolveUseCasePrompt } from '../lib/use-case-prompt.js';
import { enqueueChatRunJob, enqueueRecipeRunJob } from '../lib/jobs/enqueue.js';
import { broadcastCancel } from '../lib/jobs/cancel.js';
import {
  messageCancelChannel,
  recipeRunCancelChannel,
  recipeRunStreamKey,
  threadStreamKey,
} from '../lib/jobs/stream-keys.js';
import { getLastConnectError, pingRedis } from '../lib/jobs/redis-client.js';
import { forwardStreamToSse, isValidOffset } from '../lib/jobs/stream-bridge.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USE_CASE_ID_RE = /^[a-z][a-z0-9-]{1,127}$/;
const PROVIDERS: KnownProvider[] = ['openai', 'anthropic', 'gemini'];
const ALLOWED_STATUSES = new Set(['active', 'disabled']);

const USE_CASE_WRITE_FIELDS = new Set([
  'label',
  'description',
  'default_provider',
  'default_model',
  'allowed_models',
  'allowed_web_tools',
  'max_output_tokens',
  'daily_cost_cap_micro_usd',
  // Phase-1 skill resolution (008_ai_use_cases_skill_ref).
  'system_prompt',
  'kickoff_message',
  'skill_source_id',
  'skill_path',
  // Recipe binding (025_ai_use_cases_recipe_binding). Mutually
  // exclusive with skill_* (enforced by CHECK constraint at DB level —
  // not re-checked here; an invalid combo bubbles up as a 400 from PG).
  'recipe_source_id',
  'recipe_file_path',
  // spec-ai-mcp-extensions.md round 7 — jsonb map of allowlisted env-var
  // overrides. DB trigger validate_goose_runtime_overrides enforces the
  // allowlist + per-key range checks.
  'goose_runtime_overrides',
  // spec-ai-mcp-extensions.md round 8 — template adoption pointer.
  // template_drifted flips to true on any subsequent edit (handled
  // below in patchUseCase, not via pass-through).
  'template_id',
]);

export function pickUseCaseFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (USE_CASE_WRITE_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

export interface AdminAiRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error?(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Resolves fetch_url for use-cases that enable it. */
  resolveFetchUrl?: Parameters<typeof runChat>[0]['resolveFetchUrl'];
  /** Resolves gatewaze_search for use-cases that enable it. */
  resolveGatewazeSearch?: Parameters<typeof runChat>[0]['resolveGatewazeSearch'];
  /**
   * BullMQ enqueue, supplied by the platform's ModuleRuntimeContext.
   * Required for chat + recipe runs in the worker-dispatch model.
   */
  enqueueJob?: (
    queue: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ id: string | undefined }>;
  /** Project root passed through from the platform — used to locate the BullMQ Queue handle. */
  projectRoot?: string;
}

function paramAs(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createAdminAiRoutes(deps: AdminAiRoutesDeps) {
  const { supabase, logger } = deps;

  // ── Threads ───────────────────────────────────────────────────────────

  async function lookupThread(req: Request, res: Response): Promise<void> {
    const useCase = paramAs(req.query['use_case']);
    const hostKind = paramAs(req.query['host_kind']);
    const hostId = paramAs(req.query['host_id']);
    const threadKey = paramAs(req.query['thread_key']) ?? '';
    if (!useCase || !hostKind || !hostId) {
      sendError(res, 400, 'bad_request', 'use_case, host_kind, host_id required');
      return;
    }
    const result = await supabase
      .from('ai_threads')
      .select('*')
      .eq('use_case', useCase)
      .eq('host_kind', hostKind)
      .eq('host_id', hostId)
      .eq('thread_key', threadKey)
      .maybeSingle();
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(200).json({ thread: result.data ?? null });
  }

  /**
   * List every thread for a (use_case, host_kind, host_id) tuple — used
   * by AiChatModelTabs to restore the operator's open-tab set on page
   * refresh. Without this, only the default tab survives a reload and
   * any other model's in-flight autopilot run looks lost.
   */
  async function listThreadsByHost(req: Request, res: Response): Promise<void> {
    const useCase = paramAs(req.query['use_case']);
    const hostKind = paramAs(req.query['host_kind']);
    const hostId = paramAs(req.query['host_id']);
    if (!useCase || !hostKind || !hostId) {
      sendError(res, 400, 'bad_request', 'use_case, host_kind, host_id required');
      return;
    }
    const result = await supabase
      .from('ai_threads')
      .select('*')
      .eq('use_case', useCase)
      .eq('host_kind', hostKind)
      .eq('host_id', hostId)
      .order('created_at', { ascending: true });
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(200).json({ threads: result.data ?? [] });
  }

  async function createThread(req: Request, res: Response): Promise<void> {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const useCase = typeof body.use_case === 'string' ? body.use_case : '';
    const hostKind = typeof body.host_kind === 'string' ? body.host_kind : '';
    const hostId = typeof body.host_id === 'string' ? body.host_id : '';
    const threadKey = typeof body.thread_key === 'string' ? body.thread_key : '';
    if (!USE_CASE_ID_RE.test(useCase) || !hostKind || !hostId) {
      sendError(res, 400, 'bad_request', 'use_case (slug), host_kind, host_id required');
      return;
    }

    // Idempotent upsert.
    const existing = await supabase
      .from('ai_threads')
      .select('*')
      .eq('use_case', useCase)
      .eq('host_kind', hostKind)
      .eq('host_id', hostId)
      .eq('thread_key', threadKey)
      .maybeSingle();
    if (existing.data) {
      res.status(200).json({ thread: existing.data });
      return;
    }
    const created = await supabase
      .from('ai_threads')
      .insert({ use_case: useCase, host_kind: hostKind, host_id: hostId, thread_key: threadKey, status: 'idle' })
      .select('*')
      .maybeSingle();
    // Race: a concurrent caller (autopilot, second tab) may have inserted
    // the same addressable row between our SELECT and INSERT. The unique
    // constraint catches it — re-SELECT and return the winner instead of
    // 500'ing the caller.
    if (created.error && /ai_threads_addressable_unique/.test(created.error.message)) {
      const refetch = await supabase
        .from('ai_threads')
        .select('*')
        .eq('use_case', useCase)
        .eq('host_kind', hostKind)
        .eq('host_id', hostId)
        .eq('thread_key', threadKey)
        .maybeSingle();
      if (refetch.data) {
        res.status(200).json({ thread: refetch.data });
        return;
      }
      sendError(res, 500, 'internal', refetch.error?.message ?? 'lost addressable race and row not found');
      return;
    }
    if (created.error) {
      sendError(res, 500, 'internal', created.error.message);
      return;
    }
    res.status(201).json({ thread: created.data });
  }

  async function getThread(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const threadRes = await supabase
      .from('ai_threads')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (threadRes.error || !threadRes.data) {
      sendError(res, 404, 'not_found', 'thread not found');
      return;
    }
    const msgRes = await supabase
      .from('ai_messages')
      .select('*')
      .eq('thread_id', id)
      .order('created_at', { ascending: true });
    res.status(200).json({ thread: threadRes.data, messages: msgRes.data ?? [] });
  }

  async function deleteThread(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const result = await supabase.from('ai_threads').delete().eq('id', id);
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(204).end();
  }

  /**
   * POST a message into a thread. Returns 202 + the persisted user
   * placeholder + the assistant placeholder; runs the LLM call in the
   * background and updates the assistant placeholder when done.
   */
  async function postMessage(req: Request, res: Response): Promise<void> {
    const threadId = paramAs(req.params.id);
    if (!threadId || !UUID_RE.test(threadId)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const userMessage = typeof body.message === 'string' ? body.message.trim() : '';
    if (!userMessage) {
      sendError(res, 400, 'bad_request', 'message required');
      return;
    }
    const provider = typeof body.provider === 'string' ? (body.provider as 'auto' | KnownProvider) : 'auto';
    const model = typeof body.model === 'string' ? body.model : undefined;
    // Optional per-tab recipe override. When the operator picks a
    // specific sub-recipe in the chat widget's Will-run panel, this
    // path is forwarded to the chat handler, which loads the named
    // recipe's instructions + response schema INSTEAD of the chat-
    // handler's default "first sub-recipe of the use case's bound
    // parent" auto-pick. The worker re-validates against the parent's
    // sub_recipe_refs so this can't be used to load arbitrary recipes.
    const recipeOverridePath = typeof body.recipe_override_path === 'string' && body.recipe_override_path.length > 0
      ? body.recipe_override_path
      : undefined;

    const threadRes = await supabase
      .from('ai_threads')
      .select('*')
      .eq('id', threadId)
      .maybeSingle();
    if (threadRes.error || !threadRes.data) {
      sendError(res, 404, 'not_found', 'thread not found');
      return;
    }

    // Reject concurrent runs.
    const inflight = await supabase
      .from('ai_messages')
      .select('id, status')
      .eq('thread_id', threadId)
      .eq('status', 'running')
      .maybeSingle();
    if (inflight.data) {
      sendError(res, 409, 'thread_busy', 'an assistant message is already running');
      return;
    }

    // spec-ai-job-runner §3.2 — enqueue a chat job; the worker picks it
    // up and emits to the thread's Redis Stream.
    if (!deps.enqueueJob) {
      sendError(res, 503, 'enqueue_unavailable', 'enqueueJob not wired by host');
      return;
    }
    if (!(await pingRedis())) {
      sendError(
        res,
        503,
        'redis_unavailable',
        `Redis ping failed: ${getLastConnectError() ?? 'unknown'}`,
      );
      return;
    }

    // Persist user turn + assistant placeholder (status='queued').
    const userInsert = await supabase
      .from('ai_messages')
      .insert({ thread_id: threadId, role: 'user', status: 'complete', content: userMessage })
      .select('*')
      .maybeSingle();
    if (userInsert.error) {
      sendError(res, 500, 'internal', userInsert.error.message);
      return;
    }
    const placeholderInsert = await supabase
      .from('ai_messages')
      .insert({ thread_id: threadId, role: 'assistant', status: 'queued', content: '' })
      .select('*')
      .maybeSingle();
    if (placeholderInsert.error) {
      sendError(res, 500, 'internal', placeholderInsert.error.message);
      return;
    }
    await supabase
      .from('ai_threads')
      .update({ status: 'running', last_error: null })
      .eq('id', threadId);

    let jobId: string | undefined;
    let delayed = false;
    try {
      const enq = await enqueueChatRunJob(deps.enqueueJob, {
        threadId,
        assistantMessageId: placeholderInsert.data.id,
        useCase: threadRes.data.use_case,
        userId: threadRes.data.created_by,
        // Forward the widget's model/provider so the worker's
        // run-chat-handler can pass `--provider/--model` to `goose
        // run`. Without these, Goose's `goose run` has no default
        // provider configured in the worker env (no GOOSE_PROVIDER /
        // GOOSE_MODEL) and exits 1 silently — every follow-up chat
        // turn looked like it failed for no reason.
        ...(provider !== 'auto' ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(recipeOverridePath ? { recipeOverridePath } : {}),
      });
      jobId = enq.jobId;
      delayed = enq.delayed;
      await supabase
        .from('ai_messages')
        .update({ bull_job_id: enq.jobId ?? null })
        .eq('id', placeholderInsert.data.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase
        .from('ai_messages')
        .update({ status: 'failed', error_code: 'enqueue_failed', error_message: msg })
        .eq('id', placeholderInsert.data.id);
      sendError(res, 500, 'enqueue_failed', msg);
      return;
    }

    res.status(202).json({
      user_message: userInsert.data,
      assistant_message: placeholderInsert.data,
      job_id: jobId,
      delayed,
      stream_url: `/api/modules/ai/admin/threads/${threadId}/stream`,
    });
  }

  // Removed in spec-ai-job-runner — chat execution now lives in
  // workers/run-chat-handler.ts. Stub kept temporarily so any stale
  // references compile. Delete once the next commit cycle confirms
  // no internal callers.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function runBackground_DEPRECATED(args: {
    threadId: string;
    threadRow: { use_case: string; created_by: string | null };
    assistantMessageId: string;
    userMessage: string;
    provider: 'auto' | KnownProvider;
    model: string | undefined;
  }): Promise<void> {
    try {
      // Build conversation from prior messages.
      const history = await supabase
        .from('ai_messages')
        .select('role, content, status')
        .eq('thread_id', args.threadId)
        .neq('id', args.assistantMessageId)
        .order('created_at', { ascending: true });
      const messages = (history.data ?? [])
        .filter(
          (m: { status: string; role: string }) =>
            m.status === 'complete' && (m.role === 'user' || m.role === 'assistant'),
        )
        .map((m: { role: string; content: string }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      // System prompt: resolve from the use case (skill body if a skill
      // is bound, else the inline system_prompt column). Phase-1 added
      // skill_ref support to ai_use_cases (migration 008); the chat
      // path now uses it so the operator's configured skill drives
      // every turn — not just the host-module-specific dedicated
      // endpoints. Empty string is still valid (means "no system
      // prompt"); the provider clients pass it through unchanged.
      const resolved = await resolveUseCasePrompt(
        supabase as never,
        args.threadRow.use_case,
      );

      const result = await runChat(
        {
          supabase,
          logger,
          resolveFetchUrl: deps.resolveFetchUrl,
          resolveGatewazeSearch: deps.resolveGatewazeSearch,
        },
        {
          useCase: args.threadRow.use_case,
          userId: args.threadRow.created_by,
          threadId: args.threadId,
          messageId: args.assistantMessageId,
          systemPrompt: resolved.systemPrompt,
          messages,
          provider: args.provider,
          model: args.model,
        },
      );

      await supabase
        .from('ai_messages')
        .update({
          status: 'complete',
          content: result.narrative,
          structured: result.structured,
          provider: result.provider,
          model: result.model,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          cost_micro_usd: result.costMicroUsd,
          latency_ms: result.latencyMs,
        })
        .eq('id', args.assistantMessageId);

      await supabase
        .from('ai_threads')
        .update({
          status: 'ready',
          last_error: null,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          cost_micro_usd: result.costMicroUsd,
        })
        .eq('id', args.threadId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('ai.chat.background_failed', { thread_id: args.threadId, error: message });
      await supabase
        .from('ai_messages')
        .update({
          status: 'failed',
          error_code: 'provider_error',
          error_message: message,
        })
        .eq('id', args.assistantMessageId);
      await supabase
        .from('ai_threads')
        .update({ status: 'failed', last_error: message })
        .eq('id', args.threadId);
    }
  }

  async function cancelMessage(req: Request, res: Response): Promise<void> {
    const messageId = paramAs(req.params.messageId);
    if (!messageId || !UUID_RE.test(messageId)) {
      sendError(res, 400, 'bad_request', 'message_id (uuid) required');
      return;
    }
    // spec-ai-job-runner §4.3 — three-channel cancel:
    //   (1) DB row, (2) pub/sub broadcast, (3) the worker's step poll.
    const update = await supabase
      .from('ai_messages')
      .update({ status: 'cancelling', cancel_requested_at: new Date().toISOString() })
      .eq('id', messageId)
      .in('status', ['queued', 'running'])
      .select('*')
      .maybeSingle();
    try {
      await broadcastCancel(messageCancelChannel(messageId), 'user');
    } catch {
      // Best-effort; the DB row + worker poll will still pick it up.
    }
    res.status(202).json({ cancelled: Boolean(update.data) });
  }

  // ── Use-cases ─────────────────────────────────────────────────────────

  async function listUseCases(_req: Request, res: Response): Promise<void> {
    const result = await supabase
      .from('ai_use_cases')
      .select('*')
      .order('id', { ascending: true });
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(200).json({ use_cases: result.data ?? [] });
  }

  async function patchUseCase(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !USE_CASE_ID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (slug) required');
      return;
    }
    const fields = pickUseCaseFields(req.body);
    if (Object.keys(fields).length === 0) {
      sendError(res, 400, 'bad_request', 'no updatable fields');
      return;
    }
    const result = await supabase
      .from('ai_use_cases')
      .update(fields)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error || !result.data) {
      sendError(res, 404, 'not_found', result.error?.message ?? 'use_case not found');
      return;
    }
    res.status(200).json({ use_case: result.data });
  }

  /**
   * Lists models the requesting user can use for a given use-case.
   * `available: true` iff there's a resolvable key.
   */
  /**
   * Pre-run preview — resolve the use-case prompt source WITHOUT
   * invoking the model. Returns the same PromptSource snapshot the
   * worker would persist onto ai_messages.prompt_source after a run,
   * so the chat widget can show operators which skill/commit will be
   * used before they click "Run research" / Send.
   *
   * Spec: provenance addendum to spec-ai-job-runner — the
   * configured-now snapshot is just the post-run snapshot resolved
   * at fetch time.
   */
  async function getUseCasePromptSource(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !USE_CASE_ID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (slug) required');
      return;
    }
    try {
      const resolved = await resolveUseCasePrompt(supabase as never, id);
      // When the use case is bound to a recipe with declared
      // sub_recipes, surface the available sub-recipe choices so the
      // chat widget's Will-run panel can render a per-tab "Run as"
      // override picker. Operators can then pick which sub-recipe a
      // given tab runs (e.g. force the Gemini 3 Pro tab to run the
      // sonnet research sub-recipe).
      let availableSubRecipes: Array<{
        name: string;
        path: string;
        title: string | null;
      }> = [];
      const ps = resolved.promptSource;
      const recipeMeta = ps?.system_prompt?.kind === 'recipe'
        ? (ps.system_prompt as { recipe?: { recipe_id?: string; source_id?: string } }).recipe
        : null;
      if (recipeMeta?.recipe_id && recipeMeta?.source_id) {
        const parentRes = await supabase
          .from('ai_recipes')
          .select('sub_recipe_refs')
          .eq('id', recipeMeta.recipe_id)
          .maybeSingle();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refs = (parentRes.data as any)?.sub_recipe_refs ?? [];
        if (Array.isArray(refs) && refs.length > 0) {
          const paths = refs
            .map((r: { path?: string }) => r?.path)
            .filter((p: unknown): p is string => typeof p === 'string' && p.length > 0);
          if (paths.length > 0) {
            const titlesRes = await supabase
              .from('ai_recipes')
              .select('file_path, title')
              .eq('source_id', recipeMeta.source_id)
              .in('file_path', paths);
            const titleMap = new Map<string, string>();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const row of (titlesRes.data ?? []) as any[]) {
              if (row?.file_path && row?.title) titleMap.set(row.file_path, row.title);
            }
            availableSubRecipes = refs
              .map((r: { name?: string; path?: string }) => ({
                name: typeof r.name === 'string' ? r.name : '',
                path: typeof r.path === 'string' ? r.path : '',
                title: titleMap.get(r.path ?? '') ?? null,
              }))
              .filter((r: { path: string }) => r.path.length > 0);
          }
        }
      }
      res.status(200).json({
        prompt_source: resolved.promptSource,
        // The resolved strings are useful for "expand to see the
        // actual prompt that'll be sent" — but they can be tens of
        // KB. Echo a length + sha hint instead.
        system_prompt_preview: resolved.systemPrompt.slice(0, 280),
        kickoff_message_preview: resolved.kickoffMessage.slice(0, 280),
        available_sub_recipes: availableSubRecipes,
      });
    } catch (err) {
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  }

  async function listUseCaseModels(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !USE_CASE_ID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (slug) required');
      return;
    }
    const uc = await supabase
      .from('ai_use_cases')
      .select('allowed_models')
      .eq('id', id)
      .maybeSingle();
    if (uc.error || !uc.data) {
      sendError(res, 404, 'not_found', 'use_case not found');
      return;
    }
    const allowed = (uc.data.allowed_models ?? []) as string[];
    if (allowed.length === 0) {
      res.status(200).json({ models: [] });
      return;
    }
    // Hydrate price + capability metadata.
    const priceRows = await supabase
      .from('ai_model_prices')
      .select('provider, model, label, supports_chat, supports_tools, supports_web_search, supports_image_gen, supports_embeddings, input_per_million_usd, output_per_million_usd')
      .in('model', allowed);
    const byModel = new Map<string, Record<string, unknown>>();
    for (const row of (priceRows.data ?? []) as Array<{ model: string } & Record<string, unknown>>) {
      // Pick the most-recent effective_from per model.
      if (!byModel.has(row.model)) byModel.set(row.model, row);
    }
    res.status(200).json({
      models: allowed.map((m) => byModel.get(m) ?? { model: m, label: m }),
    });
  }

  // ── Model catalog ──────────────────────────────────────────────────────
  //
  // CRUD over ai_model_prices, exposed as a flat catalog ("which models
  // exist in this Gatewaze install?"). Because ai_model_prices is keyed
  // by (provider, model, effective_from), the catalog view collapses to
  // the most-recent effective_from row per (provider, model). Edits
  // update that row in place — historical accuracy of past cost-ledger
  // calculations is preserved by the per-event snapshot in
  // ai_usage_events.cost_micro_usd, not by the price book.

  async function listModels(_req: Request, res: Response): Promise<void> {
    const result = await supabase
      .from('ai_model_prices')
      .select('*')
      .order('provider', { ascending: true })
      .order('effective_from', { ascending: false });
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    // Collapse to the latest effective_from per (provider, model).
    const seen = new Set<string>();
    type PriceRow = { provider: string; model: string } & Record<string, unknown>;
    const latest: PriceRow[] = [];
    for (const row of (result.data ?? []) as PriceRow[]) {
      const key = `${row.provider}:${row.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(row);
    }
    latest.sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.model.localeCompare(b.model);
    });
    res.status(200).json({ models: latest });
  }

  const MODEL_WRITE_FIELDS = new Set([
    'label',
    'input_per_million_usd',
    'output_per_million_usd',
    'cached_per_million_usd',
    'cache_creation_per_million_usd',
    'image_per_image_usd',
    'supports_chat',
    'supports_tools',
    'supports_web_search',
    'supports_image_gen',
    'supports_embeddings',
  ]);

  function pickModelFields(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (MODEL_WRITE_FIELDS.has(k)) out[k] = v;
    }
    return out;
  }

  async function createModel(req: Request, res: Response): Promise<void> {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const provider = typeof body.provider === 'string' ? body.provider : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!['openai', 'anthropic', 'gemini', 'scrapling'].includes(provider)) {
      sendError(res, 400, 'bad_request', 'provider must be one of openai/anthropic/gemini/scrapling');
      return;
    }
    if (!model || model.length > 128) {
      sendError(res, 400, 'bad_request', 'model id required (≤128 chars)');
      return;
    }
    const fields = pickModelFields(body);
    // Today's date as the new row's effective_from. If a row already
    // exists for (provider, model, today) the unique PK collides — re-
    // surface a 409 rather than a generic 500 so the UI can react.
    const today = new Date().toISOString().slice(0, 10);
    const result = await supabase
      .from('ai_model_prices')
      .insert({ provider, model, effective_from: today, ...fields })
      .select('*')
      .maybeSingle();
    if (result.error) {
      if (/duplicate key|unique/i.test(result.error.message)) {
        sendError(res, 409, 'conflict', `model ${provider}/${model} already has a price row dated ${today}`);
        return;
      }
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(201).json({ model: result.data });
  }

  async function updateModel(req: Request, res: Response): Promise<void> {
    const provider = paramAs(req.params.provider);
    const model = paramAs(req.params.model);
    if (!provider || !model) {
      sendError(res, 400, 'bad_request', 'provider + model required');
      return;
    }
    const fields = pickModelFields(req.body);
    if (Object.keys(fields).length === 0) {
      sendError(res, 400, 'bad_request', 'no editable fields supplied');
      return;
    }
    // Find the latest effective_from row and update in place.
    const latest = await supabase
      .from('ai_model_prices')
      .select('effective_from')
      .eq('provider', provider)
      .eq('model', model)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest.error || !latest.data) {
      sendError(res, 404, 'not_found', 'model not found');
      return;
    }
    const result = await supabase
      .from('ai_model_prices')
      .update(fields)
      .eq('provider', provider)
      .eq('model', model)
      .eq('effective_from', latest.data.effective_from)
      .select('*')
      .maybeSingle();
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(200).json({ model: result.data });
  }

  async function deleteModel(req: Request, res: Response): Promise<void> {
    const provider = paramAs(req.params.provider);
    const model = paramAs(req.params.model);
    if (!provider || !model) {
      sendError(res, 400, 'bad_request', 'provider + model required');
      return;
    }
    // Drops ALL effective-from rows for this (provider, model). Past
    // ai_usage_events rows already snapshot their cost_micro_usd, so
    // historical reporting is unaffected. Any use_case rows that name
    // this model in allowed_models keep the string — they will surface
    // as "uncatalogued" in the picker until an operator re-creates the
    // catalog entry.
    const result = await supabase
      .from('ai_model_prices')
      .delete()
      .eq('provider', provider)
      .eq('model', model);
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(204).end();
  }

  // ── Price-book refresh from upstream (LiteLLM) ─────────────────────────
  //
  // Manual trigger that enqueues the same BullMQ job the weekly cron
  // runs. The worker (workers/refresh-model-prices.js) pulls the latest
  // LiteLLM JSON, diffs against the latest row per (provider, model),
  // and writes a new effective-dated row for every delta. Hand-curated
  // rows (provider not in LiteLLM's keep list — `scrapling`, internal
  // tool-cost markers, etc.) are left alone.
  async function refreshPrices(req: Request, res: Response): Promise<void> {
    if (!deps.enqueueJob) {
      sendError(res, 503, 'enqueue_unavailable', 'enqueueJob not wired by host');
      return;
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const dryRun = body.dry_run === true;
    const url = typeof body.url === 'string' ? body.url : undefined;
    try {
      const job = await deps.enqueueJob('jobs', 'ai:refresh-model-prices', {
        kind: 'ai:refresh-model-prices',
        ...(dryRun ? { dry_run: true } : {}),
        ...(url ? { url } : {}),
      });
      res.status(202).json({ job_id: job?.id ?? null, dry_run: dryRun });
    } catch (err) {
      sendError(res, 500, 'enqueue_failed', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Credentials ────────────────────────────────────────────────────────

  async function listCredentials(_req: Request, res: Response): Promise<void> {
    // Cleartext is NEVER returned. Only metadata.
    const userRes = await supabase
      .from('ai_user_credentials')
      .select('id, user_id, provider, status, last_4, failure_count, last_used_at, created_at, rotated_at');
    const useCaseRes = await supabase
      .from('ai_use_case_credentials')
      .select('id, use_case, provider, status, last_4, failure_count, last_used_at, created_at, rotated_at');
    res.status(200).json({
      user_credentials: userRes.data ?? [],
      use_case_credentials: useCaseRes.data ?? [],
    });
  }

  async function createUserCredential(req: Request, res: Response): Promise<void> {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    const provider = typeof body.provider === 'string' ? (body.provider as KnownProvider) : '' as KnownProvider;
    const apiKey = typeof body.api_key === 'string' ? body.api_key : '';
    if (!UUID_RE.test(userId) || !PROVIDERS.includes(provider) || !apiKey) {
      sendError(res, 400, 'bad_request', 'user_id (uuid), provider, api_key required');
      return;
    }
    const encrypted = await encryptKey(supabase, apiKey);
    const last4 = apiKey.slice(-4);
    const result = await supabase
      .from('ai_user_credentials')
      .insert({
        user_id: userId,
        provider,
        api_key_ciphertext: encrypted.ciphertext,
        api_key_nonce: encrypted.nonce,
        last_4: last4,
        status: 'active',
      })
      .select('id, user_id, provider, status, last_4')
      .maybeSingle();
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(201).json({ credential: result.data });
  }

  async function deleteUserCredential(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    await supabase.from('ai_user_credentials').delete().eq('id', id);
    res.status(204).end();
  }

  async function createUseCaseCredential(req: Request, res: Response): Promise<void> {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const useCase = typeof body.use_case === 'string' ? body.use_case : '';
    const provider = typeof body.provider === 'string' ? (body.provider as KnownProvider) : '' as KnownProvider;
    const apiKey = typeof body.api_key === 'string' ? body.api_key : '';
    if (!USE_CASE_ID_RE.test(useCase) || !PROVIDERS.includes(provider) || !apiKey) {
      sendError(res, 400, 'bad_request', 'use_case (slug), provider, api_key required');
      return;
    }
    const encrypted = await encryptKey(supabase, apiKey);
    const last4 = apiKey.slice(-4);
    const result = await supabase
      .from('ai_use_case_credentials')
      .insert({
        use_case: useCase,
        provider,
        api_key_ciphertext: encrypted.ciphertext,
        api_key_nonce: encrypted.nonce,
        last_4: last4,
        status: 'active',
      })
      .select('id, use_case, provider, status, last_4')
      .maybeSingle();
    if (result.error) {
      if (/duplicate key|unique/i.test(result.error.message)) {
        sendError(res, 409, 'conflict', `${useCase} already has an active ${provider} credential — delete it first to replace`);
        return;
      }
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(201).json({ credential: result.data });
  }

  async function deleteUseCaseCredential(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    await supabase.from('ai_use_case_credentials').delete().eq('id', id);
    res.status(204).end();
  }

  // ── Usage / cost ──────────────────────────────────────────────────────

  async function usageSummary(req: Request, res: Response): Promise<void> {
    const fromIso = paramAs(req.query['from']) ?? startOfThisMonthIso();
    const toIso = paramAs(req.query['to']) ?? new Date().toISOString();
    const result = await supabase
      .from('ai_usage_events')
      .select('user_id, use_case, provider, model, kind, cost_micro_usd, input_tokens, output_tokens')
      .gte('occurred_at', fromIso)
      .lte('occurred_at', toIso);
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    const rows = (result.data ?? []) as Array<{
      user_id: string | null;
      use_case: string;
      provider: string;
      model: string;
      kind: string;
      cost_micro_usd: number | string;
      input_tokens: number;
      output_tokens: number;
    }>;
    const total = rows.reduce((sum, r) => sum + Number(r.cost_micro_usd), 0);
    const byProvider = aggregate(rows, (r) => r.provider);
    const byUser = aggregate(rows, (r) => r.user_id ?? '__system__');
    const byUseCase = aggregate(rows, (r) => r.use_case);
    res.status(200).json({
      from: fromIso,
      to: toIso,
      total_cost_micro_usd: total,
      by_provider: byProvider,
      by_user: byUser,
      by_use_case: byUseCase,
    });
  }

  async function usageEvents(req: Request, res: Response): Promise<void> {
    const fromIso = paramAs(req.query['from']) ?? startOfThisMonthIso();
    const toIso = paramAs(req.query['to']) ?? new Date().toISOString();
    const userId = paramAs(req.query['user_id']);
    const useCase = paramAs(req.query['use_case']);
    const limit = Math.min(Math.max(parseInt(paramAs(req.query['limit']) ?? '100', 10), 1), 1000);
    const offset = Math.max(parseInt(paramAs(req.query['offset']) ?? '0', 10), 0);

    let query = supabase
      .from('ai_usage_events')
      .select('*')
      .gte('occurred_at', fromIso)
      .lte('occurred_at', toIso)
      .order('occurred_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (userId && UUID_RE.test(userId)) query = query.eq('user_id', userId);
    if (useCase && USE_CASE_ID_RE.test(useCase)) query = query.eq('use_case', useCase);

    const result = await query;
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(200).json({ events: result.data ?? [], limit, offset });
  }

  // ── Recipes ───────────────────────────────────────────────────────────
  //
  // Per spec-ai-workflows-and-skill-interop.md §5. v1 ships the
  // execution surface (POST /recipes/run-inline + GET /recipe-runs/:id
  // + DELETE /recipe-runs/:id). The CRUD-over-ai_recipes endpoints
  // and the recipe-sync worker are next-pass work — at that point a
  // `POST /recipes/:id/run` endpoint replaces `run-inline`.
  //
  // The inline path accepts a YAML body so authors can paste a Goose
  // recipe straight from their editor without wiring up a git source
  // first. It's the same code path runRecipe() will take when called
  // from the sync-driven endpoint, so smoke tests cover both.

  async function runRecipeInline(req: Request, res: Response): Promise<void> {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const yaml = typeof body.yaml === 'string' ? body.yaml : '';
    const useCase = typeof body.use_case === 'string' ? body.use_case : '';
    const params = (body.params && typeof body.params === 'object'
      ? (body.params as Record<string, unknown>)
      : {}) as Record<string, never>;
    const pathPrefix = typeof body.path_prefix === 'string' ? body.path_prefix : '';
    const userId = typeof body.user_id === 'string' && UUID_RE.test(body.user_id)
      ? body.user_id
      : null;
    if (!yaml) {
      sendError(res, 400, 'bad_request', 'body.yaml required');
      return;
    }
    if (!USE_CASE_ID_RE.test(useCase)) {
      sendError(res, 400, 'bad_request', 'body.use_case (slug) required');
      return;
    }

    const parsed = parseRecipe('inline.yaml', yaml, {
      sourceId: 'inline',
      pathPrefix,
    });
    if (!parsed.ok) {
      sendError(res, 400, parsed.reason, JSON.stringify({
        message: parsed.reason === 'parse_error' ? parsed.message : 'tier-3 refused',
        refusal: parsed.reason === 'refused' ? parsed.refusal : undefined,
        partial: parsed.partial,
      }));
      return;
    }

    // Sub-recipes can't resolve in inline mode (no source registry).
    // If the recipe declares any, refuse — author needs the sync
    // worker path.
    if (parsed.recipe.sub_recipes.length > 0) {
      sendError(
        res,
        400,
        'unsupported',
        'inline runs do not support sub_recipes — register the source via /recipe-sources first',
      );
      return;
    }

    // spec-ai-job-runner §5.1 — inline-recipe runs go through the
    // same worker dispatch as source-registered ones. Snapshot the
    // parsed recipe on the run row so the worker has everything it
    // needs without source lookup.
    if (!deps.enqueueJob) {
      sendError(res, 503, 'enqueue_unavailable', 'enqueueJob not wired by host');
      return;
    }
    if (!(await pingRedis())) {
      sendError(
        res,
        503,
        'redis_unavailable',
        `Redis ping failed: ${getLastConnectError() ?? 'unknown'}`,
      );
      return;
    }
    const insertRes = await supabase
      .from('ai_recipe_runs')
      .insert({
        recipe_id: null,
        recipe_file_path: null,
        recipe_content_hash: parsed.recipe.content_hash,
        user_id: userId,
        use_case: useCase,
        host_kind: null,
        host_id: null,
        params: params as unknown as Record<string, unknown>,
        status: 'queued',
        steps: [],
        recipe_snapshot: parsed.recipe as unknown as Record<string, unknown>,
        sub_recipes_snapshot: {} as Record<string, unknown>,
        recipe_source: {
          kind: 'inline',
          recipe_id: null,
          file_path: null,
          content_hash: parsed.recipe.content_hash,
          last_commit_sha: null,
          source: null,
          sub_recipes: [],
        } as unknown as Record<string, unknown>,
      })
      .select('id')
      .maybeSingle();
    if (insertRes.error || !insertRes.data) {
      sendError(res, 500, 'internal', insertRes.error?.message ?? 'no row returned');
      return;
    }
    const runId = insertRes.data.id as string;
    try {
      const enq = await enqueueRecipeRunJob(deps.enqueueJob, {
        runId,
        useCase,
        userId,
      });
      await supabase
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
  }

  async function getRecipeRun(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const result = await supabase
      .from('ai_recipe_runs')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', 'recipe run not found');
      return;
    }
    res.status(200).json({ run: result.data });
  }

  async function cancelRecipeRun(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const row = await supabase
      .from('ai_recipe_runs')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (row.error || !row.data) {
      sendError(res, 404, 'not_found', 'recipe run not found');
      return;
    }
    // spec-ai-job-runner §4.3 — three-channel cancel for in-flight runs.
    // Terminal runs (complete/failed/cancelled) get deleted as before.
    if (['queued', 'running'].includes(row.data.status as string)) {
      await supabase
        .from('ai_recipe_runs')
        .update({ status: 'cancelling', cancel_requested_at: new Date().toISOString() })
        .eq('id', id);
      try {
        await broadcastCancel(recipeRunCancelChannel(id), 'user');
      } catch {
        // Best-effort.
      }
      res.status(202).json({ status: 'cancelling' });
      return;
    }
    await supabase.from('ai_recipe_runs').delete().eq('id', id);
    res.status(204).end();
  }

  /**
   * Per-day cost breakdown for the daily-breakdown chart on the AI
   * usage tab. Returns `[{ day, provider, cost_micro_usd, event_count }]`
   * collapsed in JS — Supabase's PostgREST doesn't have a GROUP BY
   * primitive so we pull rows and aggregate in-process. Volume is bounded
   * by the dashboard's date filter (typically ≤ a month).
   */
  async function usageDaily(req: Request, res: Response): Promise<void> {
    const fromIso = paramAs(req.query['from']) ?? startOfThisMonthIso();
    const toIso = paramAs(req.query['to']) ?? new Date().toISOString();
    const result = await supabase
      .from('ai_usage_events')
      .select('occurred_at, provider, cost_micro_usd')
      .gte('occurred_at', fromIso)
      .lte('occurred_at', toIso);
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    const rows = (result.data ?? []) as Array<{
      occurred_at: string;
      provider: string;
      cost_micro_usd: number | string;
    }>;
    // Bucket by (day, provider). Day = UTC YYYY-MM-DD slice of the ISO
    // timestamp — keeps the chart aligned with Anthropic's daily CSV.
    const buckets = new Map<string, { cost: number; count: number }>();
    for (const r of rows) {
      const day = r.occurred_at.slice(0, 10);
      const key = `${day}|${r.provider}`;
      const cur = buckets.get(key) ?? { cost: 0, count: 0 };
      cur.cost += typeof r.cost_micro_usd === 'number'
        ? r.cost_micro_usd
        : parseInt(String(r.cost_micro_usd), 10) || 0;
      cur.count += 1;
      buckets.set(key, cur);
    }
    const days: Array<{ day: string; provider: string; cost_micro_usd: number; event_count: number }> = [];
    for (const [key, v] of buckets) {
      const [day, provider] = key.split('|') as [string, string];
      days.push({ day, provider, cost_micro_usd: v.cost, event_count: v.count });
    }
    days.sort((a, b) => (a.day === b.day ? a.provider.localeCompare(b.provider) : a.day.localeCompare(b.day)));
    res.status(200).json({ from: fromIso, to: toIso, days });
  }

  return {
    lookupThread,
    listThreadsByHost,
    createThread,
    getThread,
    deleteThread,
    postMessage,
    cancelMessage,
    listUseCases,
    patchUseCase,
    listUseCaseModels,
    getUseCasePromptSource,
    listModels,
    createModel,
    updateModel,
    deleteModel,
    refreshPrices,
    listCredentials,
    createUserCredential,
    deleteUserCredential,
    createUseCaseCredential,
    deleteUseCaseCredential,
    usageSummary,
    usageEvents,
    usageDaily,
    runRecipeInline,
    getRecipeRun,
    cancelRecipeRun,
  };
}

export function mountAdminAiRoutes(
  router: Router,
  routes: ReturnType<typeof createAdminAiRoutes>,
): void {
  router.get('/admin/threads', routes.lookupThread);
  // Must precede `/admin/threads/:id` — Express matches in order and
  // `by-host` would otherwise be interpreted as a thread id.
  router.get('/admin/threads/by-host', routes.listThreadsByHost);
  router.post('/admin/threads', routes.createThread);
  router.get('/admin/threads/:id', routes.getThread);
  router.delete('/admin/threads/:id', routes.deleteThread);
  router.post('/admin/threads/:id/messages', routes.postMessage);
  router.post('/admin/threads/:id/messages/:messageId/cancel', routes.cancelMessage);

  router.get('/admin/use-cases', routes.listUseCases);
  router.patch('/admin/use-cases/:id', routes.patchUseCase);
  router.get('/admin/use-cases/:id/models', routes.listUseCaseModels);
  router.get('/admin/use-cases/:id/prompt-source', routes.getUseCasePromptSource);

  router.get('/admin/models', routes.listModels);
  router.post('/admin/models', routes.createModel);
  router.patch('/admin/models/:provider/:model', routes.updateModel);
  router.delete('/admin/models/:provider/:model', routes.deleteModel);
  router.post('/admin/prices/refresh', routes.refreshPrices);

  router.get('/admin/credentials', routes.listCredentials);
  router.post('/admin/credentials/user', routes.createUserCredential);
  router.delete('/admin/credentials/user/:id', routes.deleteUserCredential);
  router.post('/admin/credentials/use-case', routes.createUseCaseCredential);
  router.delete('/admin/credentials/use-case/:id', routes.deleteUseCaseCredential);

  router.get('/admin/usage/summary', routes.usageSummary);
  router.get('/admin/usage/events', routes.usageEvents);
  router.get('/admin/usage/daily', routes.usageDaily);

  // Recipe execution (v1: inline only — no sync-driven /recipes/:id/run
  // yet; that ships with the sync worker in the next pass).
  router.post('/admin/recipes/run-inline', routes.runRecipeInline);
  router.get('/admin/recipe-runs/:id', routes.getRecipeRun);
  router.delete('/admin/recipe-runs/:id', routes.cancelRecipeRun);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Encrypt an API key via pgsodium. Calls `pgsodium_encrypt_text(p_plaintext)`
 * which the platform exposes (alongside its decrypt twin). Returns
 * raw bytes for ciphertext + nonce; Postgres bytea columns accept hex.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function encryptKey(supabase: any, plaintext: string): Promise<{ ciphertext: string; nonce: string }> {
  const result = await supabase.rpc('pgsodium_encrypt_text', { p_plaintext: plaintext });
  if (result.error || !result.data) {
    throw new Error(`pgsodium encrypt failed: ${result.error?.message ?? 'no data'}`);
  }
  return result.data as { ciphertext: string; nonce: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aggregate<T extends Record<string, any>>(
  rows: T[],
  keyFn: (r: T) => string,
): Array<{ key: string; cost_micro_usd: number; input_tokens: number; output_tokens: number; event_count: number }> {
  const out = new Map<string, { cost_micro_usd: number; input_tokens: number; output_tokens: number; event_count: number }>();
  for (const r of rows) {
    const k = keyFn(r);
    const cur = out.get(k) ?? { cost_micro_usd: 0, input_tokens: 0, output_tokens: 0, event_count: 0 };
    cur.cost_micro_usd += Number(r.cost_micro_usd ?? 0);
    cur.input_tokens += Number(r.input_tokens ?? 0);
    cur.output_tokens += Number(r.output_tokens ?? 0);
    cur.event_count += 1;
    out.set(k, cur);
  }
  return Array.from(out.entries()).map(([key, v]) => ({ key, ...v }));
}

function startOfThisMonthIso(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Avoid `sumSpentMicroUsd` being unused — re-exported for tests.
export { sumSpentMicroUsd };
