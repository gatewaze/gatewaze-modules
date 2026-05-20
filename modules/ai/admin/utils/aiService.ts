/**
 * Admin-side client for the @gatewaze-modules/ai REST surface.
 *
 * Mirrors the endpoint catalogue in api/admin-routes.ts. All calls go
 * through the JWT-gated /api/modules/ai/admin/* prefix; bearer token is
 * pulled from the supabase session.
 */

import { supabase } from '@/lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────

export type AiProvider = 'openai' | 'anthropic' | 'gemini';
export type AiAutoOrProvider = 'auto' | AiProvider;
export type AiThreadStatus = 'idle' | 'running' | 'ready' | 'failed' | 'cancelled';
export type AiMessageStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface AiThread {
  id: string;
  use_case: string;
  host_kind: string;
  host_id: string;
  thread_key: string;
  status: AiThreadStatus;
  last_error: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface PromptSourceSnapshot {
  use_case: string;
  system_prompt: {
    kind: 'skill' | 'recipe' | 'inline' | 'empty';
    content_hash: string;
    char_count: number;
    skill?: {
      source_id: string;
      source_label: string | null;
      name: string;
      dir_path: string;
      content_hash: string;
      last_commit_sha: string;
    };
    recipe?: {
      source_id: string;
      source_label: string | null;
      recipe_id: string;
      title: string;
      file_path: string;
      content_hash: string;
      last_commit_sha: string;
    };
  };
  kickoff_message: {
    kind: 'inline' | 'empty';
    char_count: number;
  };
}

export interface AiMessage {
  id: string;
  thread_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool_summary';
  status: AiMessageStatus;
  content: string;
  structured: Record<string, unknown> | null;
  provider: AiProvider | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  latency_ms: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  /** Provenance snapshot captured at run time. Migration 023. */
  prompt_source: PromptSourceSnapshot | null;
}

export interface AiUseCase {
  id: string;
  label: string;
  description: string;
  default_provider: AiAutoOrProvider;
  default_model: string;
  allowed_models: string[];
  /**
   * Narrow to the DB CHECK constraint (migration 012). gatewaze_search
   * is the operator-friendly third tool — Serper.dev when configured,
   * DuckDuckGo via scrapling-fetcher otherwise.
   */
  allowed_web_tools: ('web_search' | 'fetch_url' | 'gatewaze_search')[];
  max_output_tokens: number;
  daily_cost_cap_micro_usd: number | null;
  /**
   * Inline system prompt. Used at runtime when no skill is bound (see
   * skill_source_id/skill_path). Operator-editable via the admin.
   */
  system_prompt: string;
  /**
   * Initial user turn fired by autopilot triggers (e.g. daily-briefing
   * "Run research"). Empty = no kickoff; system_prompt alone drives
   * the model.
   */
  kickoff_message: string;
  /**
   * Skill binding — FK to ai_agent_sources.id. When paired with
   * skill_path, the matching ai_skills.body becomes the system prompt
   * at runtime, overriding the inline system_prompt above. Mutually
   * exclusive with recipe_source_id.
   */
  skill_source_id: string | null;
  /** dir_path within the agent source, matching ai_skills.dir_path. */
  skill_path: string | null;
  /**
   * Recipe binding — FK to ai_agent_sources.id. When paired with
   * recipe_file_path, "Run" enqueues an ai:run-recipe job against the
   * bound recipe instead of firing a free-form chat. Mutually exclusive
   * with skill_source_id. Migration 025.
   */
  recipe_source_id: string | null;
  /** Path of the recipe.yaml within the agent source (e.g. recipes/foo/recipe.yaml). */
  recipe_file_path: string | null;
  /**
   * spec-ai-mcp-extensions.md round 7 — jsonb map of allowlisted env
   * overrides (GOOSE_AUTO_COMPACT_THRESHOLD, GOOSE_TOOL_CALL_CUTOFF,
   * GOOSE_MODE, CLAUDE_THINKING_TYPE, GATEWAZE_GOOSE_MAX_*,
   * GATEWAZE_MEMORY_DEFAULT_TTL_SECONDS). DB trigger validates keys
   * + ranges. Empty object = use worker env defaults.
   */
  goose_runtime_overrides: Record<string, unknown>;
  /**
   * spec-ai-mcp-extensions.md round 8 — adopted template id. Drift
   * flag flips on any subsequent edit to a template-controlled field.
   */
  template_id: string | null;
  template_drifted: boolean;
  created_at: string;
  updated_at: string;
}

/** Lightweight reference to a skill row for the use-case picker. */
export interface AiSkillRef {
  id: string;
  source_id: string;
  source_label: string;
  /** Repo-relative directory path (agentskills.io dir_path). */
  path: string;
  name: string;
}

/** Lightweight reference to a recipe row for the use-case picker. */
export interface AiRecipeRef {
  id: string;
  source_id: string;
  source_label: string;
  /** Repo-relative file path (e.g. recipes/<name>/recipe.yaml). */
  file_path: string;
  title: string;
}

export interface AiUserCredentialMeta {
  id: string;
  user_id: string;
  provider: AiProvider;
  status: 'active' | 'disabled' | 'rotating';
  last_4: string;
  failure_count: number;
  last_used_at: string | null;
  created_at: string;
  rotated_at: string | null;
}

export interface AiUseCaseCredentialMeta {
  id: string;
  use_case: string;
  provider: AiProvider;
  status: 'active' | 'disabled' | 'rotating';
  last_4: string;
  failure_count: number;
  last_used_at: string | null;
  created_at: string;
}

export interface AiModelInfo {
  provider: AiProvider;
  model: string;
  label: string;
  supports_chat?: boolean;
  supports_tools?: boolean;
  supports_web_search?: boolean;
  supports_image_gen?: boolean;
  supports_embeddings?: boolean;
  input_per_million_usd?: number;
  output_per_million_usd?: number;
}

/** Catalog entry exposed by /admin/models (latest effective_from per model). */
export interface AiCatalogModel {
  provider: AiProvider | 'scrapling';
  model: string;
  label: string;
  effective_from: string;
  input_per_million_usd: number;
  output_per_million_usd: number;
  cached_per_million_usd: number | null;
  cache_creation_per_million_usd: number | null;
  image_per_image_usd: number | null;
  supports_chat: boolean;
  supports_tools: boolean;
  supports_web_search: boolean;
  supports_image_gen: boolean;
  supports_embeddings: boolean;
}

export interface AiCatalogModelInput {
  label?: string;
  input_per_million_usd?: number;
  output_per_million_usd?: number;
  cached_per_million_usd?: number | null;
  cache_creation_per_million_usd?: number | null;
  image_per_image_usd?: number | null;
  supports_chat?: boolean;
  supports_tools?: boolean;
  supports_web_search?: boolean;
  supports_image_gen?: boolean;
  supports_embeddings?: boolean;
}

export interface AiUsageSummary {
  from: string;
  to: string;
  total_cost_micro_usd: number;
  by_provider: Array<{ key: string; cost_micro_usd: number; input_tokens: number; output_tokens: number; event_count: number }>;
  by_user: Array<{ key: string; cost_micro_usd: number; input_tokens: number; output_tokens: number; event_count: number }>;
  by_use_case: Array<{ key: string; cost_micro_usd: number; input_tokens: number; output_tokens: number; event_count: number }>;
}

export interface AiUsageEvent {
  id: string;
  occurred_at: string;
  user_id: string | null;
  use_case: string;
  thread_id: string | null;
  message_id: string | null;
  kind: 'llm' | 'tool' | 'embedding' | 'image';
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  image_outputs: number;
  cost_micro_usd: number;
  latency_ms: number;
  status: string;
  error: string | null;
}

// ─── Plumbing ─────────────────────────────────────────────────────────────

function apiUrl(): string {
  return (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.message) detail = body.message;
      else if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// ─── Threads ──────────────────────────────────────────────────────────────

export async function lookupThread(opts: {
  useCase: string;
  hostKind: string;
  hostId: string;
  threadKey?: string;
}): Promise<AiThread | null> {
  const qs = new URLSearchParams({
    use_case: opts.useCase,
    host_kind: opts.hostKind,
    host_id: opts.hostId,
    thread_key: opts.threadKey ?? '',
  });
  const res = await authedFetch(`/api/modules/ai/admin/threads?${qs.toString()}`);
  const body = await jsonOrThrow<{ thread: AiThread | null }>(res);
  return body.thread;
}

/**
 * List every thread (across all thread_keys) for a host. Used by
 * AiChatModelTabs to restore the operator's open-tab set on page
 * refresh — without this, only the default tab survives a reload and
 * any other model's in-flight run looks lost.
 */
export async function listThreadsByHost(opts: {
  useCase: string;
  hostKind: string;
  hostId: string;
}): Promise<AiThread[]> {
  const qs = new URLSearchParams({
    use_case: opts.useCase,
    host_kind: opts.hostKind,
    host_id: opts.hostId,
  });
  const res = await authedFetch(`/api/modules/ai/admin/threads/by-host?${qs.toString()}`);
  const body = await jsonOrThrow<{ threads: AiThread[] }>(res);
  return body.threads;
}

export async function createThread(opts: {
  useCase: string;
  hostKind: string;
  hostId: string;
  threadKey?: string;
}): Promise<AiThread> {
  const res = await authedFetch('/api/modules/ai/admin/threads', {
    method: 'POST',
    body: JSON.stringify({
      use_case: opts.useCase,
      host_kind: opts.hostKind,
      host_id: opts.hostId,
      thread_key: opts.threadKey ?? '',
    }),
  });
  const body = await jsonOrThrow<{ thread: AiThread }>(res);
  return body.thread;
}

export async function getThread(threadId: string): Promise<{ thread: AiThread; messages: AiMessage[] }> {
  const res = await authedFetch(`/api/modules/ai/admin/threads/${threadId}`);
  return jsonOrThrow(res);
}

export async function deleteThread(threadId: string): Promise<void> {
  const res = await authedFetch(`/api/modules/ai/admin/threads/${threadId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

export async function postMessage(opts: {
  threadId: string;
  message: string;
  provider?: AiAutoOrProvider;
  model?: string;
}): Promise<{ user_message: AiMessage; assistant_message: AiMessage }> {
  const res = await authedFetch(`/api/modules/ai/admin/threads/${opts.threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message: opts.message, provider: opts.provider, model: opts.model }),
  });
  return jsonOrThrow(res);
}

export async function cancelMessage(threadId: string, messageId: string): Promise<void> {
  const res = await authedFetch(
    `/api/modules/ai/admin/threads/${threadId}/messages/${messageId}/cancel`,
    { method: 'POST' },
  );
  if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`);
}

// ─── Use-cases ────────────────────────────────────────────────────────────

export async function listUseCases(): Promise<AiUseCase[]> {
  const res = await authedFetch('/api/modules/ai/admin/use-cases');
  const body = await jsonOrThrow<{ use_cases: AiUseCase[] }>(res);
  return body.use_cases;
}

export async function patchUseCase(id: string, patch: Partial<AiUseCase>): Promise<AiUseCase> {
  const res = await authedFetch(`/api/modules/ai/admin/use-cases/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  const body = await jsonOrThrow<{ use_case: AiUseCase }>(res);
  return body.use_case;
}

export async function listUseCaseModels(useCaseId: string): Promise<AiModelInfo[]> {
  const res = await authedFetch(`/api/modules/ai/admin/use-cases/${useCaseId}/models`);
  const body = await jsonOrThrow<{ models: AiModelInfo[] }>(res);
  return body.models;
}

export interface UseCasePromptSourceResponse {
  prompt_source: PromptSourceSnapshot | null;
  system_prompt_preview: string;
  kickoff_message_preview: string;
}

/**
 * Pre-run preview of which skill / prompt will be used for a use case.
 * The chat widget calls this on mount + after any patchUseCase so
 * operators can see "what will run when I click Send" without firing
 * the model. Mirrors the post-run prompt_source persisted onto
 * ai_messages — same shape, resolved at fetch time.
 */
export async function getUseCasePromptSource(
  useCaseId: string,
): Promise<UseCasePromptSourceResponse> {
  const res = await authedFetch(
    `/api/modules/ai/admin/use-cases/${useCaseId}/prompt-source`,
  );
  return jsonOrThrow<UseCasePromptSourceResponse>(res);
}

/**
 * Lists skill rows available to bind to a use case. Queries the
 * ai_skills + ai_agent_sources tables directly (RLS allows authenticated
 * SELECT). Returns empty if the agent-sources subsystem isn't installed.
 *
 * Post-migration 024: skills live under ai_agent_sources (renamed from
 * ai_skill_sources), and the path column was renamed dir_path in 013.
 * The query returns dir_path mapped to `path` on the DTO so the
 * use-case modal's existing prop wiring works unchanged.
 */
export async function listAiSkills(): Promise<AiSkillRef[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('ai_skills')
    .select('id, source_id, dir_path, name, ai_agent_sources!inner(label)')
    .eq('parse_status', 'ok')
    .order('name', { ascending: true });
  if (error) {
    // Table missing (subsystem not installed) — treat as empty.
    return [];
  }
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    source_id: r.source_id as string,
    source_label:
      (r.ai_agent_sources as { label?: string } | null)?.label ?? '—',
    path: r.dir_path as string,
    name: r.name as string,
  }));
}

/**
 * Lists recipe rows available to bind to a use case. Same pattern as
 * listAiSkills but against ai_recipes. The use-case modal lets an
 * operator bind EITHER a skill OR a recipe — they're mutually
 * exclusive (a recipe IS the workflow body, no separate prompt).
 */
export async function listAiRecipes(): Promise<AiRecipeRef[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('ai_recipes')
    .select('id, source_id, file_path, title, ai_agent_sources!inner(label)')
    .eq('parse_status', 'ok')
    .order('title', { ascending: true });
  if (error) return [];
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    source_id: r.source_id as string,
    source_label:
      (r.ai_agent_sources as { label?: string } | null)?.label ?? '—',
    file_path: r.file_path as string,
    title: r.title as string,
  }));
}

// ─── Model catalog ────────────────────────────────────────────────────────

export async function listCatalogModels(): Promise<AiCatalogModel[]> {
  const res = await authedFetch('/api/modules/ai/admin/models');
  const body = await jsonOrThrow<{ models: AiCatalogModel[] }>(res);
  return body.models;
}

export async function createCatalogModel(opts: {
  provider: AiCatalogModel['provider'];
  model: string;
} & AiCatalogModelInput): Promise<AiCatalogModel> {
  const res = await authedFetch('/api/modules/ai/admin/models', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
  const body = await jsonOrThrow<{ model: AiCatalogModel }>(res);
  return body.model;
}

export async function updateCatalogModel(
  provider: AiCatalogModel['provider'],
  model: string,
  patch: AiCatalogModelInput,
): Promise<AiCatalogModel> {
  const res = await authedFetch(
    `/api/modules/ai/admin/models/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  const body = await jsonOrThrow<{ model: AiCatalogModel }>(res);
  return body.model;
}

export async function deleteCatalogModel(
  provider: AiCatalogModel['provider'],
  model: string,
): Promise<void> {
  const res = await authedFetch(
    `/api/modules/ai/admin/models/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

// ─── Credentials ──────────────────────────────────────────────────────────

export async function listCredentials(): Promise<{
  user_credentials: AiUserCredentialMeta[];
  use_case_credentials: AiUseCaseCredentialMeta[];
}> {
  const res = await authedFetch('/api/modules/ai/admin/credentials');
  return jsonOrThrow(res);
}

export async function createUserCredential(opts: {
  userId: string;
  provider: AiProvider;
  apiKey: string;
}): Promise<AiUserCredentialMeta> {
  const res = await authedFetch('/api/modules/ai/admin/credentials/user', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      provider: opts.provider,
      api_key: opts.apiKey,
    }),
  });
  const body = await jsonOrThrow<{ credential: AiUserCredentialMeta }>(res);
  return body.credential;
}

export async function deleteUserCredential(id: string): Promise<void> {
  const res = await authedFetch(`/api/modules/ai/admin/credentials/user/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

export async function createUseCaseCredential(opts: {
  useCase: string;
  provider: AiProvider;
  apiKey: string;
}): Promise<AiUseCaseCredentialMeta> {
  const res = await authedFetch('/api/modules/ai/admin/credentials/use-case', {
    method: 'POST',
    body: JSON.stringify({
      use_case: opts.useCase,
      provider: opts.provider,
      api_key: opts.apiKey,
    }),
  });
  const body = await jsonOrThrow<{ credential: AiUseCaseCredentialMeta }>(res);
  return body.credential;
}

export async function deleteUseCaseCredential(id: string): Promise<void> {
  const res = await authedFetch(`/api/modules/ai/admin/credentials/use-case/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

// ─── Usage / cost ─────────────────────────────────────────────────────────

export async function getUsageSummary(opts?: { from?: string; to?: string }): Promise<AiUsageSummary> {
  const qs = new URLSearchParams();
  if (opts?.from) qs.set('from', opts.from);
  if (opts?.to) qs.set('to', opts.to);
  const res = await authedFetch(`/api/modules/ai/admin/usage/summary${qs.toString() ? '?' + qs : ''}`);
  return jsonOrThrow(res);
}

export async function listUsageEvents(opts?: {
  from?: string;
  to?: string;
  userId?: string;
  useCase?: string;
  limit?: number;
  offset?: number;
}): Promise<{ events: AiUsageEvent[]; limit: number; offset: number }> {
  const qs = new URLSearchParams();
  if (opts?.from) qs.set('from', opts.from);
  if (opts?.to) qs.set('to', opts.to);
  if (opts?.userId) qs.set('user_id', opts.userId);
  if (opts?.useCase) qs.set('use_case', opts.useCase);
  if (opts?.limit) qs.set('limit', String(opts.limit));
  if (opts?.offset) qs.set('offset', String(opts.offset));
  const res = await authedFetch(`/api/modules/ai/admin/usage/events${qs.toString() ? '?' + qs : ''}`);
  return jsonOrThrow(res);
}

export interface AiUsageDailyRow {
  day: string;          // 'YYYY-MM-DD' UTC
  provider: string;     // 'anthropic' | 'openai' | 'gemini' | 'scrapling'
  cost_micro_usd: number;
  event_count: number;
}

export async function getUsageDaily(opts?: { from?: string; to?: string }): Promise<{
  from: string;
  to: string;
  days: AiUsageDailyRow[];
}> {
  const qs = new URLSearchParams();
  if (opts?.from) qs.set('from', opts.from);
  if (opts?.to) qs.set('to', opts.to);
  const res = await authedFetch(`/api/modules/ai/admin/usage/daily${qs.toString() ? '?' + qs : ''}`);
  return jsonOrThrow(res);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function microUsdToDollars(microUsd: number | null | undefined): string {
  if (!microUsd) return '$0.00';
  const dollars = Number(microUsd) / 1_000_000;
  if (dollars >= 1000) return `$${dollars.toFixed(0)}`;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(4)}`;
}
