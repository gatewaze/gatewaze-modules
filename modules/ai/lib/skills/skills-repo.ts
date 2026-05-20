/**
 * Data-access for the AI Skills feature.
 *
 * Centralises all reads/writes for `ai_agent_sources`, `ai_skills`, and
 * `ai_agent_source_webhook_log` so routes stay declarative and the
 * tests can mock one Supabase shim.
 *
 * Per spec-ai-skills.md §10 — every public endpoint maps to one of
 * these functions.
 */

import { encryptSecret, getLast4, maskSecret } from './secret-shim.js';
import { randomBytes } from 'node:crypto';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface SkillSourceRow {
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

export interface SkillSourceResponse {
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

export interface SkillRow {
  id: string;
  source_id: string;
  /**
   * Full path of the skill directory within the repo (e.g.
   * `.claude/skills/brand-voice`). Replaces the v1 `path` column,
   * which pointed at a loose `.md` file before the agentskills.io
   * migration (013).
   */
  dir_path: string;
  /** Skill identifier; equals `basename(dir_path)` per spec invariant. */
  name: string;
  /** Required, ≤1024. */
  description: string;
  /** Flat string→string metadata; arbitrary Tier-2 fields land here. */
  metadata: Record<string, string>;
  /** Sibling-file relative paths inside the skill dir. Inert in v1. */
  resources: string[];
  body: string;
  body_chars: number;
  content_hash: string;
  parse_status: 'ok' | 'refused' | 'parse_error';
  unsupported_features: Array<{ feature: string; location: { line: number; col: number; snippet: string } }>;
  parse_warnings: string[];
  last_commit_sha: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

function project(row: SkillSourceRow): SkillSourceResponse {
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

// ---------------------------------------------------------------------------
// SOURCES
// ---------------------------------------------------------------------------

export async function listSources(supabase: SupabaseLike): Promise<SkillSourceResponse[]> {
  const res = await supabase
    .from('ai_agent_sources')
    .select('*')
    .order('created_at', { ascending: false });
  const rows = (res?.data as SkillSourceRow[] | null) ?? [];
  return rows.map(project);
}

export async function readSource(supabase: SupabaseLike, id: string): Promise<SkillSourceResponse | null> {
  const res = await supabase.from('ai_agent_sources').select('*').eq('id', id).maybeSingle();
  const row = res?.data as SkillSourceRow | null;
  return row ? project(row) : null;
}

export interface CreateSourceInput {
  label: string;
  description?: string;
  git_url: string;
  branch?: string;
  path_prefix?: string;
  auth_token?: string;
  webhook_provider?: 'github' | 'gitlab' | 'gitea';
  created_by?: string;
}

export async function createSource(
  supabase: SupabaseLike,
  input: CreateSourceInput,
): Promise<{ ok: true; row: SkillSourceResponse; webhook_secret: string } | { ok: false; reason: string }> {
  // Encryption only kicks in when an auth_token was supplied (public
  // repos don't need one). When the operator did supply a token but
  // GATEWAZE_SECRETS_KEY isn't configured on the instance, the shim
  // throws — historically that escaped as an unhandled rejection and
  // crashed the api process. Catch it here, return a clean reason so
  // the route handler can surface a 400 + advisory to the operator.
  let enc: string | null = null;
  let last4: string | null = null;
  if (input.auth_token) {
    try {
      enc = encryptSecret(input.auth_token);
      last4 = getLast4(input.auth_token);
    } catch (err) {
      return {
        ok: false,
        reason: `auth_token_encryption_unavailable: ${err instanceof Error ? err.message : String(err)} — set GATEWAZE_SECRETS_KEY on the api service to store private-repo tokens, or omit the token for public repos.`,
      };
    }
  }
  // Webhook secret defaults at the DB layer; we don't override here.
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
  const row = res.data as SkillSourceRow;
  return { ok: true, row: project(row), webhook_secret: row.webhook_secret };
}

export interface UpdateSourceInput {
  label?: string;
  description?: string | null;
  git_url?: string;
  branch?: string;
  path_prefix?: string;
  /**
   * Tri-state: undefined → preserve; string → re-encrypt; null → clear.
   * (Caller is responsible for distinguishing absent JSON key from
   * explicit null before mapping into this shape.)
   */
  auth_token?: string | null;
  webhook_provider?: 'github' | 'gitlab' | 'gitea';
}

export async function updateSource(
  supabase: SupabaseLike,
  id: string,
  patch: UpdateSourceInput,
): Promise<{ ok: true; row: SkillSourceResponse } | { ok: false; reason: string }> {
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
    // Same defensive catch as createSource — never let an encryption
    // failure escape as an unhandled rejection.
    try {
      update.auth_token_ciphertext = encryptSecret(patch.auth_token);
      update.auth_token_last4 = getLast4(patch.auth_token);
    } catch (err) {
      return {
        ok: false,
        reason: `auth_token_encryption_unavailable: ${err instanceof Error ? err.message : String(err)} — set GATEWAZE_SECRETS_KEY on the api service to store private-repo tokens, or omit the token for public repos.`,
      };
    }
  }
  const res = await supabase.from('ai_agent_sources').update(update).eq('id', id).select('*').single();
  if (res?.error) return { ok: false, reason: res.error.message ?? 'update_failed' };
  return { ok: true, row: project(res.data as SkillSourceRow) };
}

export async function deleteSource(
  supabase: SupabaseLike,
  id: string,
): Promise<{ deleted: true; cascadedSkillCount: number } | { deleted: false; reason: string }> {
  // Get the skill count before delete (ON DELETE CASCADE removes them).
  const countRes = await supabase
    .from('ai_skills')
    .select('id', { count: 'exact', head: true })
    .eq('source_id', id);
  const cascaded = countRes?.count ?? 0;
  const res = await supabase.from('ai_agent_sources').delete().eq('id', id);
  if (res?.error) return { deleted: false, reason: res.error.message ?? 'delete_failed' };
  return { deleted: true, cascadedSkillCount: cascaded };
}

export async function rotateWebhookSecret(
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

export async function getWebhookSecret(
  supabase: SupabaseLike,
  id: string,
): Promise<{ secret: string; provider: 'github' | 'gitlab' | 'gitea' } | null> {
  const res = await supabase
    .from('ai_agent_sources')
    .select('webhook_secret, webhook_provider')
    .eq('id', id)
    .maybeSingle();
  const row = res?.data as { webhook_secret: string; webhook_provider: SkillSourceRow['webhook_provider'] } | null;
  if (!row) return null;
  return { secret: row.webhook_secret, provider: row.webhook_provider };
}

// ---------------------------------------------------------------------------
// SKILLS (read-only — git is the writer)
// ---------------------------------------------------------------------------

export interface SkillListItem {
  id: string;
  source_id: string;
  source_label: string;
  dir_path: string;
  name: string;
  description: string;
  metadata: Record<string, string>;
  body_chars: number;
  parse_status: 'ok' | 'refused' | 'parse_error';
  updated_at: string;
}

export interface ListSkillsFilter {
  source_id?: string;
  /**
   * Filter by parse_status. Default behaviour returns only `'ok'`
   * rows — refused / parse_error rows are hidden from the picker
   * surface but visible to the admin UI when explicitly requested.
   */
  parse_status?: 'ok' | 'refused' | 'parse_error' | 'all';
}

const SKILL_LIST_COLS =
  'id, source_id, dir_path, name, description, metadata, body_chars, parse_status, updated_at, source:ai_agent_sources!source_id(label)';

export async function listSkills(
  supabase: SupabaseLike,
  filter: ListSkillsFilter = {},
): Promise<SkillListItem[]> {
  let q = supabase
    .from('ai_skills')
    .select(SKILL_LIST_COLS)
    .order('name', { ascending: true });
  if (filter.source_id) q = q.eq('source_id', filter.source_id);
  const statusFilter = filter.parse_status ?? 'ok';
  if (statusFilter !== 'all') q = q.eq('parse_status', statusFilter);
  const res = await q;
  const rows = (res?.data as Array<SkillRow & { source: { label: string } | null }> | null) ?? [];
  return rows.map((r) => ({
    id: r.id,
    source_id: r.source_id,
    source_label: r.source?.label ?? '(unknown source)',
    dir_path: r.dir_path,
    name: r.name,
    description: r.description,
    metadata: r.metadata,
    body_chars: r.body_chars,
    parse_status: r.parse_status,
    updated_at: r.updated_at,
  }));
}

export async function readSkillFull(supabase: SupabaseLike, id: string): Promise<SkillRow | null> {
  const res = await supabase.from('ai_skills').select('*').eq('id', id).maybeSingle();
  return (res?.data as SkillRow | null) ?? null;
}

/**
 * Bulk read by ids, preserving input order. Missing ids are silently
 * dropped (caller handles "deleted from git" warnings). Refused /
 * parse_error rows are filtered out — the runner only loads bodies
 * for ok-parsed skills.
 */
export async function readSkillsByIds(supabase: SupabaseLike, ids: string[]): Promise<SkillRow[]> {
  if (ids.length === 0) return [];
  const res = await supabase
    .from('ai_skills')
    .select('*')
    .in('id', ids)
    .eq('parse_status', 'ok');
  const rows = (res?.data as SkillRow[] | null) ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is SkillRow => r != null);
}

// ---------------------------------------------------------------------------
// WEBHOOK LOG
// ---------------------------------------------------------------------------

export interface WebhookLogEntry {
  id: string;
  source_id: string;
  received_at: string;
  remote_addr: string | null;
  provider: string;
  event_type: string | null;
  status: string;
  status_reason: string | null;
  payload_size: number | null;
  signature_valid: boolean | null;
}

export async function listWebhookLog(
  supabase: SupabaseLike,
  sourceId: string,
  limit = 50,
): Promise<WebhookLogEntry[]> {
  const res = await supabase
    .from('ai_agent_source_webhook_log')
    .select('*')
    .eq('source_id', sourceId)
    .order('received_at', { ascending: false })
    .limit(limit);
  return (res?.data as WebhookLogEntry[] | null) ?? [];
}

export async function writeWebhookLog(
  supabase: SupabaseLike,
  entry: Omit<WebhookLogEntry, 'id' | 'received_at'> & { received_at?: string },
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

// ---------------------------------------------------------------------------
// re-export display helpers
// ---------------------------------------------------------------------------

export { maskSecret, getLast4 };
