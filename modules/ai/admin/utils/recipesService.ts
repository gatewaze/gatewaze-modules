/**
 * Browser-side fetch wrappers for the AI Recipes routes.
 *
 * Mirrors skillsService — Bearer JWT auth, JSON envelopes, ok-or-error
 * discriminated unions.
 *
 * Routes are mounted by api/recipe-sources.ts + api/recipe-webhook.ts +
 * the inline-run handler in api/admin-routes.ts. See
 * spec-ai-workflows-and-skill-interop.md §5.
 */

import { supabase } from '@/lib/supabase';

const API_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  return fetch(`${API_URL}${path}`, { ...init, headers });
}

// ─── Types ──────────────────────────────────────────────────────────

export interface RecipeSource {
  id: string;
  label: string;
  description: string | null;
  git_url: string;
  branch: string;
  path_prefix: string;
  auth_token_last4: string | null;
  webhook_provider: 'github' | 'gitlab' | 'gitea';
  last_synced_at: string | null;
  last_synced_commit: string | null;
  sync_status: 'pending' | 'syncing' | 'ok' | 'error';
  sync_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecipeSourceCreated extends RecipeSource {
  webhook_secret: string;
}

export interface RecipeListItem {
  id: string;
  source_id: string;
  source_label: string;
  file_path: string;
  title: string;
  description: string | null;
  parse_status: 'ok' | 'refused' | 'parse_error';
  has_sub_recipes: boolean;
  updated_at: string;
}

export interface RecipeFull {
  id: string;
  source_id: string;
  file_path: string;
  version: string | null;
  title: string;
  description: string | null;
  instructions: string;
  prompt: string | null;
  parameters: Array<Record<string, unknown>>;
  response_schema: Record<string, unknown> | null;
  settings: Record<string, unknown>;
  sub_recipe_refs: Array<Record<string, unknown>>;
  extensions: Array<Record<string, unknown>>;
  parse_status: 'ok' | 'refused' | 'parse_error';
  unsupported_features: Array<Record<string, unknown>>;
  parse_warnings: string[];
  content_hash: string;
  last_commit_sha: string;
  updated_at: string;
}

export interface RecipeRun {
  id: string;
  recipe_id: string | null;
  recipe_file_path: string | null;
  recipe_content_hash: string;
  user_id: string | null;
  use_case: string;
  host_kind: string | null;
  host_id: string | null;
  params: Record<string, unknown>;
  status: 'running' | 'complete' | 'failed' | 'cancelled' | 'budget_blocked';
  failure_reason: string | null;
  final_output: unknown;
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
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface ServiceError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  httpStatus: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

async function parseError(res: Response): Promise<ServiceError> {
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // non-JSON
  }
  return {
    code: body.error?.code ?? `http_${res.status}`,
    message: body.error?.message ?? `Request failed (${res.status})`,
    httpStatus: res.status,
    ...(body.error?.details ? { details: body.error.details } : {}),
  };
}

// ─── Service ────────────────────────────────────────────────────────

export const RecipesService = {
  // Sources

  async listSources(): Promise<Result<RecipeSource[]>> {
    const r = await authedFetch('/api/modules/ai/admin/recipe-sources');
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { sources: RecipeSource[] };
    return { ok: true, value: b.sources };
  },

  async createSource(input: {
    label: string;
    description?: string;
    git_url: string;
    branch?: string;
    path_prefix?: string;
    auth_token?: string;
    webhook_provider?: 'github' | 'gitlab' | 'gitea';
  }): Promise<Result<RecipeSourceCreated>> {
    const r = await authedFetch('/api/modules/ai/admin/recipe-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as RecipeSourceCreated;
    return { ok: true, value: b };
  },

  async readSource(id: string): Promise<Result<RecipeSource>> {
    const r = await authedFetch(`/api/modules/ai/admin/recipe-sources/${encodeURIComponent(id)}`);
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as RecipeSource;
    return { ok: true, value: b };
  },

  async updateSource(
    id: string,
    patch: {
      label?: string;
      description?: string | null;
      git_url?: string;
      branch?: string;
      path_prefix?: string;
      auth_token?: string | null;
      webhook_provider?: 'github' | 'gitlab' | 'gitea';
    },
  ): Promise<Result<RecipeSource>> {
    const r = await authedFetch(`/api/modules/ai/admin/recipe-sources/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as RecipeSource;
    return { ok: true, value: b };
  },

  async deleteSource(id: string): Promise<Result<{ deleted: true; cascaded_recipe_count: number }>> {
    const r = await authedFetch(`/api/modules/ai/admin/recipe-sources/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { deleted: true; cascaded_recipe_count: number };
    return { ok: true, value: b };
  },

  async syncSource(id: string): Promise<Result<{ job_id: string; status: 'queued' }>> {
    const r = await authedFetch(`/api/modules/ai/admin/recipe-sources/${encodeURIComponent(id)}/sync`, {
      method: 'POST',
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { job_id: string; status: 'queued' };
    return { ok: true, value: b };
  },

  async testConnection(id: string): Promise<Result<{ ok: true; head_sha: string } | { ok: false; error: string }>> {
    const r = await authedFetch(
      `/api/modules/ai/admin/recipe-sources/${encodeURIComponent(id)}/test-connection`,
      { method: 'POST' },
    );
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { ok: true; head_sha: string } | { ok: false; error: string };
    return { ok: true, value: b };
  },

  // Recipes

  async listRecipes(opts?: {
    source_id?: string;
    search?: string;
    parse_status?: 'all' | 'refused' | 'parse_error';
    limit?: number;
    offset?: number;
  }): Promise<Result<RecipeListItem[]>> {
    const qs = new URLSearchParams();
    if (opts?.source_id) qs.set('source_id', opts.source_id);
    if (opts?.search) qs.set('search', opts.search);
    if (opts?.parse_status) qs.set('parse_status', opts.parse_status);
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    if (opts?.offset != null) qs.set('offset', String(opts.offset));
    const url = `/api/modules/ai/admin/recipes${qs.toString() ? '?' + qs.toString() : ''}`;
    const r = await authedFetch(url);
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { recipes: RecipeListItem[] };
    return { ok: true, value: b.recipes };
  },

  async readRecipe(id: string): Promise<Result<RecipeFull>> {
    const r = await authedFetch(`/api/modules/ai/admin/recipes/${encodeURIComponent(id)}`);
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as RecipeFull;
    return { ok: true, value: b };
  },

  async runRecipe(
    id: string,
    body: {
      use_case: string;
      params?: Record<string, unknown>;
      host_kind?: string;
      host_id?: string;
    },
  ): Promise<Result<RecipeRun>> {
    const r = await authedFetch(`/api/modules/ai/admin/recipes/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as RecipeRun;
    return { ok: true, value: b };
  },

  async runInline(body: {
    yaml: string;
    use_case: string;
    params?: Record<string, unknown>;
    user_id?: string;
    path_prefix?: string;
  }): Promise<Result<RecipeRun>> {
    const r = await authedFetch('/api/modules/ai/admin/recipes/run-inline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as RecipeRun;
    return { ok: true, value: b };
  },

  // Runs

  async readRun(id: string): Promise<Result<RecipeRun>> {
    const r = await authedFetch(`/api/modules/ai/admin/recipe-runs/${encodeURIComponent(id)}`);
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { run: RecipeRun };
    return { ok: true, value: b.run };
  },

  async cancelRun(id: string): Promise<Result<{ status: 'cancelling' } | undefined>> {
    const r = await authedFetch(`/api/modules/ai/admin/recipe-runs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (r.status === 204) return { ok: true, value: undefined };
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { status: 'cancelling' };
    return { ok: true, value: b };
  },
};
