import { getApiBaseUrl } from '@/config/brands';

export interface TriageItem {
  id: string;
  content_type: string;
  content_id: string;
  source: string;
  source_ref: string | null;
  suggested_categories: string[];
  suggested_from: string;
  applied_categories: string[];
  status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
  priority: number;
  is_featured: boolean;
  assigned_to: string | null;
  assigned_at: string | null;
  team_name: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_notes: string | null;
  reject_reason: string | null;
  auto_approved_at: string | null;
  auto_approved_reason: string | null;
  flagged_at: string | null;
  lifecycle_key: number;
  metadata: Record<string, unknown>;
  updated_at: string;
  created_at: string;
}

export interface TriageEvent {
  id: string;
  item_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface TriageRoute {
  id: string;
  name: string;
  description: string | null;
  content_type: string | null;
  category: string | null;
  source: string | null;
  source_ref_filter: string | null;
  metadata_filter: Record<string, unknown> | null;
  assign_to: string | null;
  assign_to_team_name: string | null;
  notify_channels: string[];
  mode_override: 'auto_publish' | 'auto_approve' | 'review' | null;
  priority: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

function api() { return getApiBaseUrl(); }

export const TriageService = {
  async list(params: {
    status?: string;
    contentType?: string;
    source?: string;
    team?: string;
    assignedTo?: string; // uuid | 'me' | 'unassigned'
    limit?: number;
    cursor?: string;
  } = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.contentType) qs.set('contentType', params.contentType);
    if (params.source) qs.set('source', params.source);
    if (params.team) qs.set('team', params.team);
    if (params.assignedTo) qs.set('assignedTo', params.assignedTo);
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    return j<{ items: TriageItem[]; nextCursor: string | null }>(
      await fetch(`${api()}/triage/items?${qs}`, { credentials: 'include' })
    );
  },

  async get(id: string) {
    return j<{ item: TriageItem; events: TriageEvent[]; notifications: any[] }>(
      await fetch(`${api()}/triage/items/${id}`, { credentials: 'include' })
    );
  },

  async approve(id: string, body: { expectedUpdatedAt: string; appliedCategories: string[]; featured?: boolean; notes?: string | null }) {
    return j<{ status: string; itemId: string; updatedAt: string }>(
      await fetch(`${api()}/triage/items/${id}/approve`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      })
    );
  },

  async reject(id: string, body: { expectedUpdatedAt: string; reason: string }) {
    return j<{ status: string; itemId: string; updatedAt: string }>(
      await fetch(`${api()}/triage/items/${id}/reject`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      })
    );
  },

  async requestChanges(id: string, body: { expectedUpdatedAt: string; notes: string }) {
    return j<{ status: string; itemId: string; updatedAt: string }>(
      await fetch(`${api()}/triage/items/${id}/request-changes`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      })
    );
  },

  async assign(id: string, body: { expectedUpdatedAt: string; assignedTo?: string | null; team?: string | null }) {
    return j<{ status: string; itemId: string; updatedAt: string }>(
      await fetch(`${api()}/triage/items/${id}/assign`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      })
    );
  },

  async reopen(id: string, body: { expectedUpdatedAt: string }) {
    return j<{ status: string; itemId: string; updatedAt: string; lifecycleKey: number }>(
      await fetch(`${api()}/triage/items/${id}/reopen`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      })
    );
  },

  async myQueueCount() {
    return j<{ count: number }>(await fetch(`${api()}/triage/my-queue/count`, { credentials: 'include' }));
  },

  async notifications(limit = 50) {
    return j<{ notifications: any[] }>(await fetch(`${api()}/triage/notifications?limit=${limit}`, { credentials: 'include' }));
  },

  async markRead(id: string) {
    return j<{ ok: boolean }>(
      await fetch(`${api()}/triage/notifications/${id}/read`, { method: 'POST', credentials: 'include' })
    );
  },

  async routes() {
    return j<{ routes: TriageRoute[] }>(await fetch(`${api()}/triage/routes`, { credentials: 'include' }));
  },
  async createRoute(body: Partial<TriageRoute>) {
    return j<{ route: TriageRoute }>(
      await fetch(`${api()}/triage/routes`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  },
  async updateRoute(id: string, body: Partial<TriageRoute>) {
    return j<{ route: TriageRoute }>(
      await fetch(`${api()}/triage/routes/${id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  },
  async deleteRoute(id: string) {
    const res = await fetch(`${api()}/triage/routes/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    }
  },
  async stats() {
    return j<{ byStatus: Record<string, number> }>(await fetch(`${api()}/triage/stats`, { credentials: 'include' }));
  },
};

export const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending', color: 'amber' as const },
  { value: 'approved', label: 'Approved', color: 'green' as const },
  { value: 'rejected', label: 'Rejected', color: 'red' as const },
  { value: 'changes_requested', label: 'Changes Requested', color: 'blue' as const },
];
