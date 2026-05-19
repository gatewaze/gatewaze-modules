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
import { resolveUseCasePrompt } from '../lib/use-case-prompt.js';

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

    // Persist user turn + assistant placeholder.
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
      .insert({ thread_id: threadId, role: 'assistant', status: 'running', content: '' })
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

    res.status(202).json({
      user_message: userInsert.data,
      assistant_message: placeholderInsert.data,
    });

    // Run in the background. Errors are persisted on the assistant row
    // — the HTTP response has already returned.
    void runBackground({
      threadId,
      threadRow: threadRes.data,
      assistantMessageId: placeholderInsert.data.id,
      userMessage,
      provider,
      model,
    });
  }

  async function runBackground(args: {
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
        { supabase, logger, resolveFetchUrl: deps.resolveFetchUrl },
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
    // Best-effort: flip the placeholder to 'cancelled'. The in-flight
    // background runner will detect this on next status check.
    const update = await supabase
      .from('ai_messages')
      .update({ status: 'cancelled' })
      .eq('id', messageId)
      .eq('status', 'running')
      .select('*')
      .maybeSingle();
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
    listModels,
    createModel,
    updateModel,
    deleteModel,
    listCredentials,
    createUserCredential,
    deleteUserCredential,
    createUseCaseCredential,
    deleteUseCaseCredential,
    usageSummary,
    usageEvents,
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

  router.get('/admin/models', routes.listModels);
  router.post('/admin/models', routes.createModel);
  router.patch('/admin/models/:provider/:model', routes.updateModel);
  router.delete('/admin/models/:provider/:model', routes.deleteModel);

  router.get('/admin/credentials', routes.listCredentials);
  router.post('/admin/credentials/user', routes.createUserCredential);
  router.delete('/admin/credentials/user/:id', routes.deleteUserCredential);
  router.post('/admin/credentials/use-case', routes.createUseCaseCredential);
  router.delete('/admin/credentials/use-case/:id', routes.deleteUseCaseCredential);

  router.get('/admin/usage/summary', routes.usageSummary);
  router.get('/admin/usage/events', routes.usageEvents);
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
