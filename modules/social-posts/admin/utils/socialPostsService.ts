/**
 * Admin client for /api/admin/social-posts. Every call goes through the
 * module's API (admin-gated, service role), so it works the same in the
 * standalone admin and inside the admin embed.
 */

import { getApiBaseUrl } from '@/config/brands';
import { supabase } from '@/lib/supabase';
import type { Format, Platform } from '../../lib/formats';
import type { PoolItem, PoolType } from '../../lib/pool-types';

export type DraftStatus = 'draft' | 'ready' | 'scheduled' | 'posted' | 'archived';

export interface DraftSource {
  content_type: PoolType;
  content_id: string;
  position: number;
  title: string | null;
  url: string | null;
}

export interface Draft {
  id: string;
  platform: Platform;
  format: Format;
  status: DraftStatus;
  body: string;
  hashtags: string[];
  mentions: string[];
  instructions: string | null;
  ai_model: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
  sources: DraftSource[];
}

export interface GeneratedPost {
  text: string;
  hashtags: string[];
  mentions: string[];
  warnings: string[];
  model: string | null;
}

export class SocialPostsApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'SocialPostsApiError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // The api shares no parent domain with the admin, so cookies don't ride
  // along; the access token goes in a header (same as the content inbox).
  const { data: { session } } = await supabase.auth.getSession();
  const r = await fetch(`${getApiBaseUrl()}/admin/social-posts${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    // An error page from a proxy is not JSON; fall back to the status text.
    const body = await r.json().catch(() => ({}));
    throw new SocialPostsApiError(body?.error?.message ?? r.statusText, body?.error?.code ?? `http_${r.status}`, r.status);
  }
  return r.json() as Promise<T>;
}

export const socialPostsService = {
  pool(opts: { types?: PoolType[]; q?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (opts.types?.length) qs.set('types', opts.types.join(','));
    if (opts.q) qs.set('q', opts.q);
    if (opts.limit) qs.set('limit', String(opts.limit));
    return call<{ items: PoolItem[]; available: PoolType[]; failed: PoolType[] }>(`/pool?${qs.toString()}`);
  },
  generate(input: { platform: Platform; format: Format; items: Array<{ content_type: PoolType; content_id: string }>; instructions?: string }) {
    return call<GeneratedPost>('/generate', { method: 'POST', body: JSON.stringify(input) });
  },
  listDrafts(status?: DraftStatus[]) {
    const qs = status?.length ? `?status=${status.join(',')}` : '';
    return call<{ drafts: Draft[] }>(`/drafts${qs}`).then((r) => r.drafts);
  },
  createDraft(input: {
    platform: Platform;
    format: Format;
    status: 'draft' | 'ready';
    body: string;
    hashtags: string[];
    instructions: string | null;
    ai_model: string | null;
    generated: boolean;
    sources: Array<{ content_type: PoolType; content_id: string }>;
  }) {
    return call<{ id: string; mentions: string[] }>('/drafts', { method: 'POST', body: JSON.stringify(input) });
  },
  updateDraft(id: string, patch: Partial<Pick<Draft, 'body' | 'format' | 'status' | 'hashtags' | 'ai_model' | 'instructions'>> & { regenerated?: true }) {
    return call<{ draft: Draft }>(`/drafts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.draft);
  },
};
