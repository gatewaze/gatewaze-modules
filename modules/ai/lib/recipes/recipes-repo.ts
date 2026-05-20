/**
 * Data-access for the Recipes feature.
 *
 * Parallels `lib/skills/skills-repo.ts`. Centralises reads/writes for
 * `ai_agent_sources` + `ai_recipes` so the route handlers stay
 * declarative.
 */

import { encryptSecret, getLast4 } from '../skills/secret-shim.js';
import { randomBytes } from 'node:crypto';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

// ─── Source shapes ──────────────────────────────────────────────────

export interface RecipeSourceRow {
  id: string;
  label: string;
  description: string | null;
  git_url: string;
  branch: string;
  path_prefix: string;
  auth_token_ciphertext: string | null;
  auth_token_last4: string | null;
  webhook_provider: 'github' | 'gitlab' | 'gitea';
  webhook_secret: string;
  last_synced_at: string | null;
  last_synced_commit: string | null;
  sync_status: 'pending' | 'syncing' | 'ok' | 'error';
  sync_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Public projection — never exposes `webhook_secret` or `*_ciphertext`. */
export interface RecipeSourceResponse {
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

function projectSource(row: RecipeSourceRow): RecipeSourceResponse {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    git_url: row.git_url,
    branch: row.branch,
    path_prefix: row.path_prefix,
    auth_token_last4: row.auth_token_last4,
    webhook_provider: row.webhook_provider,
    last_synced_at: row.last_synced_at,
    last_synced_commit: row.last_synced_commit,
    sync_status: row.sync_status,
    sync_error: row.sync_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── Source CRUD ────────────────────────────────────────────────────

export async function listRecipeSources(supabase: SupabaseLike): Promise<RecipeSourceResponse[]> {
  const res = await supabase
    .from('ai_agent_sources')
    .select('*')
    .order('created_at', { ascending: false });
  const rows = (res?.data as RecipeSourceRow[] | null) ?? [];
  return rows.map(projectSource);
}

export async function readRecipeSource(
  supabase: SupabaseLike,
  id: string,
): Promise<RecipeSourceResponse | null> {
  const res = await supabase.from('ai_agent_sources').select('*').eq('id', id).maybeSingle();
  const row = res?.data as RecipeSourceRow | null;
  return row ? projectSource(row) : null;
}

export interface CreateRecipeSourceInput {
  label: string;
  description?: string;
  git_url: string;
  branch?: string;
  path_prefix?: string;
  auth_token?: string;
  webhook_provider?: 'github' | 'gitlab' | 'gitea';
  created_by?: string;
}

export async function createRecipeSource(
  supabase: SupabaseLike,
  input: CreateRecipeSourceInput,
): Promise<{ ok: true; row: RecipeSourceResponse; webhook_secret: string } | { ok: false; reason: string }> {
  // Same encryption pattern as skill sources — catch the missing-key
  // case loudly so the operator gets a clean error instead of a
  // process crash.
  let enc: string | null = null;
  let last4: string | null = null;
  if (input.auth_token) {
    try {
      enc = encryptSecret(input.auth_token);
      last4 = getLast4(input.auth_token);
    } catch (err) {
      return {
        ok: false,
        reason: `auth_token_encryption_unavailable: ${
          err instanceof Error ? err.message : String(err)
        } — set GATEWAZE_SECRETS_KEY on the api service to store private-repo tokens, or omit the token for public repos.`,
      };
    }
  }
  const insert = {
    label: input.label,
    description: input.description ?? null,
    git_url: input.git_url,
    branch: input.branch ?? 'main',
    path_prefix: input.path_prefix ?? '',
    auth_token_ciphertext: enc,
    auth_token_last4: last4,
    webhook_provider: input.webhook_provider ?? 'github',
    sync_status: 'pending',
    created_by: input.created_by ?? null,
  };
  const res = await supabase.from('ai_agent_sources').insert(insert).select('*').single();
  if (res?.error) return { ok: false, reason: res.error.message ?? 'insert_failed' };
  const row = res.data as RecipeSourceRow;
  return { ok: true, row: projectSource(row), webhook_secret: row.webhook_secret };
}

export interface UpdateRecipeSourceInput {
  label?: string;
  description?: string | null;
  git_url?: string;
  branch?: string;
  path_prefix?: string;
  /** Tri-state: undefined → preserve; string → re-encrypt; null → clear. */
  auth_token?: string | null;
  webhook_provider?: 'github' | 'gitlab' | 'gitea';
}

export async function updateRecipeSource(
  supabase: SupabaseLike,
  id: string,
  patch: UpdateRecipeSourceInput,
): Promise<{ ok: true; row: RecipeSourceResponse } | { ok: false; reason: string }> {
  const update: Record<string, unknown> = {};
  if (patch.label != null) update.label = patch.label;
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.git_url != null) update.git_url = patch.git_url;
  if (patch.branch != null) update.branch = patch.branch;
  if (patch.path_prefix !== undefined) update.path_prefix = patch.path_prefix;
  if (patch.webhook_provider != null) update.webhook_provider = patch.webhook_provider;
  if (patch.auth_token === null) {
    update.auth_token_ciphertext = null;
    update.auth_token_last4 = null;
  } else if (typeof patch.auth_token === 'string' && patch.auth_token.length > 0) {
    try {
      update.auth_token_ciphertext = encryptSecret(patch.auth_token);
      update.auth_token_last4 = getLast4(patch.auth_token);
    } catch (err) {
      return {
        ok: false,
        reason: `auth_token_encryption_unavailable: ${
          err instanceof Error ? err.message : String(err)
        } — set GATEWAZE_SECRETS_KEY on the api service to store private-repo tokens, or omit the token for public repos.`,
      };
    }
  }
  const res = await supabase.from('ai_agent_sources').update(update).eq('id', id).select('*').single();
  if (res?.error) return { ok: false, reason: res.error.message ?? 'update_failed' };
  return { ok: true, row: projectSource(res.data as RecipeSourceRow) };
}

export async function deleteRecipeSource(
  supabase: SupabaseLike,
  id: string,
): Promise<{ deleted: true; cascadedRecipeCount: number } | { deleted: false; reason: string }> {
  const countRes = await supabase
    .from('ai_recipes')
    .select('id', { count: 'exact', head: true })
    .eq('source_id', id);
  const cascaded = countRes?.count ?? 0;
  const res = await supabase.from('ai_agent_sources').delete().eq('id', id);
  if (res?.error) return { deleted: false, reason: res.error.message ?? 'delete_failed' };
  return { deleted: true, cascadedRecipeCount: cascaded };
}

export async function rotateRecipeWebhookSecret(
  supabase: SupabaseLike,
  id: string,
): Promise<{ ok: true; webhook_secret: string } | { ok: false; reason: string }> {
  const newSecret = randomBytes(32).toString('hex');
  const res = await supabase
    .from('ai_agent_sources')
    .update({ webhook_secret: newSecret })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (res?.error) return { ok: false, reason: res.error.message ?? 'rotate_failed' };
  if (!res?.data) return { ok: false, reason: 'not_found' };
  return { ok: true, webhook_secret: newSecret };
}

// ─── Recipe list / read ─────────────────────────────────────────────

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

const RECIPE_LIST_COLS =
  'id, source_id, file_path, title, description, parse_status, sub_recipe_refs, updated_at, source:ai_agent_sources!source_id(label)';

export async function listRecipes(
  supabase: SupabaseLike,
  filter: {
    source_id?: string;
    parse_status?: 'ok' | 'refused' | 'parse_error' | 'all';
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<RecipeListItem[]> {
  let q = supabase
    .from('ai_recipes')
    .select(RECIPE_LIST_COLS)
    .order('title', { ascending: true });
  if (filter.source_id) q = q.eq('source_id', filter.source_id);
  const statusFilter = filter.parse_status ?? 'ok';
  if (statusFilter !== 'all') q = q.eq('parse_status', statusFilter);
  if (filter.search && filter.search.trim().length > 0) {
    // PostgREST ilike — sanitise % and _ to keep the pattern under
    // operator control.
    const safe = filter.search.replace(/[%_]/g, '\\$&');
    q = q.ilike('title', `%${safe}%`);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  q = q.range(offset, offset + limit - 1);
  const res = await q;
  const rows = (res?.data as Array<Record<string, unknown> & { source: { label: string } | null }> | null) ?? [];
  return rows.map((r) => ({
    id: r.id as string,
    source_id: r.source_id as string,
    source_label: r.source?.label ?? '(unknown source)',
    file_path: r.file_path as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    parse_status: r.parse_status as RecipeListItem['parse_status'],
    has_sub_recipes:
      Array.isArray(r.sub_recipe_refs) && (r.sub_recipe_refs as unknown[]).length > 0,
    updated_at: r.updated_at as string,
  }));
}

export interface RecipeFullRow {
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

export async function readRecipe(
  supabase: SupabaseLike,
  id: string,
): Promise<RecipeFullRow | null> {
  const res = await supabase.from('ai_recipes').select('*').eq('id', id).maybeSingle();
  return (res?.data as RecipeFullRow | null) ?? null;
}

// ─── Webhook helpers (mirrors skills-repo's surface) ────────────────

export async function getRecipeWebhookSecret(
  supabase: SupabaseLike,
  id: string,
): Promise<{ secret: string; provider: 'github' | 'gitlab' | 'gitea' } | null> {
  const res = await supabase
    .from('ai_agent_sources')
    .select('webhook_secret, webhook_provider')
    .eq('id', id)
    .maybeSingle();
  const row = res?.data as { webhook_secret: string; webhook_provider: RecipeSourceRow['webhook_provider'] } | null;
  if (!row) return null;
  return { secret: row.webhook_secret, provider: row.webhook_provider };
}

export interface RecipeWebhookLogEntry {
  id?: string;
  source_id: string | null;
  received_at?: string;
  remote_addr: string | null;
  provider: string;
  event_type: string | null;
  status: string;
  status_reason: string | null;
  payload_size: number;
  signature_valid: boolean;
}

export async function listRecipeWebhookLog(
  supabase: SupabaseLike,
  sourceId: string,
  limit = 50,
): Promise<RecipeWebhookLogEntry[]> {
  const res = await supabase
    .from('ai_agent_source_webhook_log')
    .select('*')
    .eq('source_id', sourceId)
    .order('received_at', { ascending: false })
    .limit(limit);
  return (res?.data as RecipeWebhookLogEntry[] | null) ?? [];
}

export async function writeRecipeWebhookLog(
  supabase: SupabaseLike,
  entry: Omit<RecipeWebhookLogEntry, 'id' | 'received_at'> & { received_at?: string },
): Promise<void> {
  await supabase.from('ai_agent_source_webhook_log').insert({
    source_id: entry.source_id,
    received_at: entry.received_at ?? new Date().toISOString(),
    remote_addr: entry.remote_addr,
    provider: entry.provider,
    event_type: entry.event_type,
    status: entry.status,
    status_reason: entry.status_reason,
    payload_size: entry.payload_size,
    signature_valid: entry.signature_valid,
  });
}
