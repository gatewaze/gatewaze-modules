import { getApiBaseUrl } from '@/config/brands';

export interface KeywordRule {
  id: string;
  name: string;
  description: string | null;
  pattern: string;
  pattern_type: 'substring' | 'word' | 'regex';
  case_sensitive: boolean;
  locale: string | null;
  content_types: string[];
  sources: string[] | null;
  fields: string[];
  is_active: boolean;
  row_version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecomputeJob {
  id: string;
  trigger: 'rule_change' | 'manual' | 'adapter_install' | 'backfill';
  rule_ids: string[] | null;
  content_types: string[] | null;
  status: 'pending' | 'running' | 'complete' | 'complete_with_errors' | 'failed' | 'canceled';
  rows_processed: number;
  rows_total_estimate: number | null;
  last_processed_id: string | null;
  error_message: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface AdapterRow {
  content_type: string;
  display_label: string;
  declared_fields: string[];
  declares_source: boolean;
  default_visible_when_no_rules: boolean;
  current_total_count: number | null;
  current_visible_count: number | null;
  stale_state_count: number | null;
  refreshed_at: string | null;
}

export interface PreviewImpact {
  mode: 'approx' | 'exact';
  by_content_type: Record<string, {
    sampled_rows: number;
    total_rows_estimate: number;
    current_visible: number;
    will_become_visible: number;
    will_become_hidden: number;
    evaluation_errors: number;
    note?: string;
  }>;
}

const base = () => getApiBaseUrl();

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}${input}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const code = body?.error?.code ?? `http_${r.status}`;
    const msg = body?.error?.message ?? r.statusText;
    throw Object.assign(new Error(msg), { code, status: r.status, details: body?.error?.details });
  }
  return r.json() as Promise<T>;
}

export const keywordRulesService = {
  async listRules(opts: { content_type?: string; is_active?: 'true' | 'false' | 'all'; cursor?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.content_type) q.set('content_type', opts.content_type);
    if (opts.is_active) q.set('is_active', opts.is_active);
    if (opts.cursor) q.set('cursor', opts.cursor);
    if (opts.limit) q.set('limit', String(opts.limit));
    const r = await jsonFetch<{ data: KeywordRule[]; page: { next_cursor: string | null } }>(`/content-keywords/rules?${q}`);
    return r;
  },

  async createRule(rule: Partial<KeywordRule>) {
    const r = await jsonFetch<{ data: KeywordRule }>(`/content-keywords/rules`, {
      method: 'POST',
      body: JSON.stringify(rule),
    });
    return r.data;
  },

  async updateRule(id: string, patch: Partial<KeywordRule>, rowVersion: number) {
    const r = await jsonFetch<{ data: KeywordRule }>(`/content-keywords/rules/${id}`, {
      method: 'PATCH',
      headers: { 'If-Match': String(rowVersion) },
      body: JSON.stringify(patch),
    });
    return r.data;
  },

  async deleteRule(id: string) {
    await jsonFetch<void>(`/content-keywords/rules/${id}`, { method: 'DELETE' });
  },

  async setActive(id: string, active: boolean) {
    const r = await jsonFetch<{ data: KeywordRule }>(`/content-keywords/rules/${id}/${active ? 'activate' : 'deactivate'}`, {
      method: 'POST',
    });
    return r.data;
  },

  async listAdapters() {
    const r = await jsonFetch<{ data: AdapterRow[] }>(`/content-keywords/adapters`);
    return r.data;
  },

  async refreshAdapterStats(contentType: string) {
    await jsonFetch<void>(`/content-keywords/adapters/${contentType}/refresh-stats`, { method: 'POST' });
  },

  async listRecomputes() {
    const r = await jsonFetch<{ data: RecomputeJob[] }>(`/content-keywords/recompute`);
    return r.data;
  },

  async requestRecompute(content_types: string[], opts: { rule_ids?: string[]; force?: boolean } = {}) {
    const r = await jsonFetch<{ data: { job_id: string } }>(`/content-keywords/recompute`, {
      method: 'POST',
      body: JSON.stringify({ content_types, ...opts }),
    });
    return r.data;
  },

  async deleteRecompute(id: string, opts: { force?: boolean } = {}) {
    const path = `/content-keywords/recompute/${id}${opts.force ? '?force=1' : ''}`;
    const r = await jsonFetch<{ data: { deleted: string; was_status: string } }>(path, { method: 'DELETE' });
    return r.data;
  },

  async clearStuckRecomputes() {
    const r = await jsonFetch<{ data: { cleared: number; ids: string[] } }>(
      `/content-keywords/recompute/clear-stuck`,
      { method: 'POST' }
    );
    return r.data;
  },

  async previewImpact(content_types: string[], delta: any[], mode: 'approx' | 'exact' = 'approx') {
    const r = await jsonFetch<{ data: PreviewImpact }>(`/content-keywords/preview-impact`, {
      method: 'POST',
      body: JSON.stringify({ content_types, delta, mode }),
    });
    return r.data;
  },
};
