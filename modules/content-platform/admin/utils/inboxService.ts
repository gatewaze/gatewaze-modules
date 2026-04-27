import { getApiBaseUrl } from '@/config/brands';

export type PublishState =
  | 'draft' | 'pending_review' | 'auto_suppressed'
  | 'rejected' | 'published' | 'unpublished';

export interface InboxRow {
  triage_item_id: string;
  content_type: string;
  content_id: string;
  publish_state: PublishState | null;
  category: string | null;
  title: string | null;
  subtitle: string | null;
  thumbnail_url: string | null;
  source_url: string | null;
  portal_url: string | null;
  source: { kind: string; ref: string | null; meta: Record<string, unknown> };
  matched_rules: Array<{ id: string; name: string; kind?: string }>;
  matched_member_rules: Array<{ id: string; name: string; kind?: string }>;
  submitted_at: string;
  assigned_to: string | null;
  lifecycle_key: number;
}

export interface InboxListFilters {
  content_type?: string[];
  source_kind?: string[];
  publish_state?: string[];
  category?: string[];
  member_only?: boolean;
  search?: string;
  sort?: 'newest' | 'oldest' | 'member_first';
  assigned_to?: string;
}

export interface InboxListResponse {
  data: InboxRow[];
  page: { next_cursor: string | null; estimated_total: number | null };
}

export type BulkAction = 'approve' | 'reject' | 'recategorize' | 'assign' | 'reopen';

export interface BulkResponse {
  processed: number;
  failed: number;
  errors: Array<{
    triage_item_id: string;
    code: string;
    message: string;
    current_state?: {
      status: string;
      lifecycle_key: number;
      category: string | null;
      assigned_to: string | null;
    };
  }>;
}

export interface ExplainResponse {
  triage: any;
  source: { source_kind: string; source_ref: string | null; source_meta: any } | null;
  keyword_verdict: { is_visible: boolean; matched_rule_ids: string[]; evaluated_at: string } | null;
  matched_rules: Array<{ id: string; name: string; pattern: string; metadata: any }>;
  state_history: Array<{ from_state: string | null; to_state: string; actor: string; reason: string | null; occurred_at: string }>;
}

const base = () => getApiBaseUrl();

async function jfetch<T>(input: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}${input}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error(body?.error?.message ?? r.statusText), {
      code: body?.error?.code ?? `http_${r.status}`,
      status: r.status,
    });
  }
  return r.json() as Promise<T>;
}

function toQS(filters: InboxListFilters & { cursor?: string; limit?: number }) {
  const q = new URLSearchParams();
  if (filters.cursor) q.set('cursor', filters.cursor);
  if (filters.limit) q.set('limit', String(filters.limit));
  if (filters.content_type?.length) q.set('content_type', filters.content_type.join(','));
  if (filters.source_kind?.length) q.set('source_kind', filters.source_kind.join(','));
  if (filters.publish_state?.length) q.set('publish_state', filters.publish_state.join(','));
  if (filters.category?.length) q.set('category', filters.category.join(','));
  if (filters.member_only) q.set('member_only', 'true');
  if (filters.search) q.set('search', filters.search);
  if (filters.sort) q.set('sort', filters.sort);
  if (filters.assigned_to) q.set('assigned_to', filters.assigned_to);
  return q.toString();
}

export const inboxService = {
  async list(filters: InboxListFilters & { cursor?: string; limit?: number } = {}) {
    const qs = toQS(filters);
    const r = await jfetch<InboxListResponse>(`/admin/inbox/list?${qs}`);
    return r;
  },
  async bulk(action: BulkAction, items: Array<{ triage_item_id: string; lifecycle_key: number }>, params: any = {}) {
    const r = await jfetch<{ data: BulkResponse }>(`/admin/inbox/bulk`, {
      method: 'POST',
      body: JSON.stringify({ action, selection: { mode: 'ids', items }, params }),
    });
    return r.data;
  },
  async explain(triage_item_id: string) {
    const r = await jfetch<{ data: ExplainResponse }>(`/admin/inbox/explain/${triage_item_id}`);
    return r.data;
  },
};
