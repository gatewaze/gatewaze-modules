/**
 * Browser-side fetch wrappers for the AI Skills routes.
 *
 * Mirrors the canvasAiService pattern — Bearer JWT auth, JSON
 * envelopes, ok-or-error discriminated unions for ergonomic call
 * sites.
 *
 * Routes are mounted by api/skill-sources.ts + api/skills.ts; see
 * spec-ai-skills.md §10 for the contract.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillSource {
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

export interface SkillSourceCreated extends SkillSource {
  webhook_secret: string;
}

export interface SkillListItem {
  id: string;
  source_id: string;
  source_label: string;
  path: string;
  name: string;
  description: string | null;
  tags: string[];
  applies_to: string[];
  body_chars: number;
  updated_at: string;
}

export interface SkillFull {
  id: string;
  source_id: string;
  path: string;
  name: string;
  description: string | null;
  tags: string[];
  applies_to: string[];
  body: string;
  body_chars: number;
  content_hash: string;
  last_commit_sha: string;
  updated_at: string;
}

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

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const SkillsService = {
  async listSources(): Promise<Result<SkillSource[]>> {
    const r = await authedFetch('/api/modules/ai/admin/skill-sources');
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { sources: SkillSource[] };
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
  }): Promise<Result<SkillSourceCreated>> {
    const r = await authedFetch('/api/modules/ai/admin/skill-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as SkillSourceCreated };
  },

  async readSource(id: string): Promise<Result<SkillSource>> {
    const r = await authedFetch(`/api/modules/ai/admin/skill-sources/${encodeURIComponent(id)}`);
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as SkillSource };
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
  ): Promise<Result<SkillSource>> {
    const r = await authedFetch(`/api/modules/ai/admin/skill-sources/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/merge-patch+json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as SkillSource };
  },

  async deleteSource(id: string): Promise<Result<{ deleted: true; cascaded_skill_count: number }>> {
    const r = await authedFetch(`/api/modules/ai/admin/skill-sources/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as { deleted: true; cascaded_skill_count: number } };
  },

  async syncNow(id: string): Promise<Result<{ job_id: string; status: string }>> {
    const r = await authedFetch(`/api/modules/ai/admin/skill-sources/${encodeURIComponent(id)}/sync`, {
      method: 'POST',
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as { job_id: string; status: string } };
  },

  async testConnection(id: string): Promise<Result<{ ok: true; head_sha: string } | { ok: false; error: string }>> {
    const r = await authedFetch(
      `/api/modules/ai/admin/skill-sources/${encodeURIComponent(id)}/test-connection`,
      { method: 'POST' },
    );
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as { ok: true; head_sha: string } | { ok: false; error: string } };
  },

  async rotateWebhookSecret(id: string): Promise<Result<{ webhook_secret: string }>> {
    const r = await authedFetch(
      `/api/modules/ai/admin/skill-sources/${encodeURIComponent(id)}/rotate-webhook-secret`,
      { method: 'POST' },
    );
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as { webhook_secret: string } };
  },

  async listWebhookLog(id: string, limit = 50): Promise<Result<WebhookLogEntry[]>> {
    const r = await authedFetch(
      `/api/modules/ai/admin/skill-sources/${encodeURIComponent(id)}/webhook-log?limit=${limit}`,
    );
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { events: WebhookLogEntry[] };
    return { ok: true, value: b.events };
  },

  // -------------------------------------------------------------------------
  // Skills (read-only)
  // -------------------------------------------------------------------------

  async listSkills(filter?: {
    source_id?: string;
    applies_to?: string[];
    tag?: string[];
  }): Promise<Result<SkillListItem[]>> {
    const params = new URLSearchParams();
    if (filter?.source_id) params.set('source_id', filter.source_id);
    if (filter?.applies_to && filter.applies_to.length > 0) params.set('applies_to', filter.applies_to.join(','));
    if (filter?.tag && filter.tag.length > 0) params.set('tag', filter.tag.join(','));
    const qs = params.toString();
    const path = `/api/modules/ai/admin/skills${qs ? `?${qs}` : ''}`;
    const r = await authedFetch(path);
    if (!r.ok) return { ok: false, error: await parseError(r) };
    const b = (await r.json()) as { skills: SkillListItem[] };
    return { ok: true, value: b.skills };
  },

  async readSkill(id: string): Promise<Result<SkillFull>> {
    const r = await authedFetch(`/api/modules/ai/admin/skills/${encodeURIComponent(id)}`);
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as SkillFull };
  },
};
