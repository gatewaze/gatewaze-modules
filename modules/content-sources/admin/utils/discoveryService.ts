/**
 * Admin-side access to the discovery_sources registry.
 *
 * Reads go straight to PostgREST through the admin Supabase client (RLS is
 * admin-only). Writes and the resolver go through the module's admin API in
 * api/register-routes.ts, which owns the field allowlist and enum checks.
 * API errors arrive as `{ error: { code, message, details? } }` and are
 * rethrown as DiscoveryApiError so callers can branch on the code (409
 * ALREADY_TRACKED carries the existing row's id in details).
 */

import { getApiBaseUrl } from '@/config/brands';
import { supabase } from '@/lib/supabase';

export const SOURCE_KINDS = ['feed', 'sitemap', 'html'] as const;
export const SOURCE_STATUSES = ['pending', 'active', 'paused', 'dead'] as const;
export const EGRESS_MODES = ['direct', 'residential'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export type EgressMode = (typeof EGRESS_MODES)[number];
export type AddedVia = 'admin_ui' | 'api' | 'mcp' | 'slack' | 'import';

/** Mirrors PUBLIC_SOURCE_FIELDS in lib/sources.ts. ETag/Last-Modified stay server-side. */
export interface DiscoverySource {
  id: string;
  kind: SourceKind;
  site_url: string;
  feed_url: string | null;
  path_prefix: string | null;
  foundation: string;
  project: string;
  content_category: string | null;
  status: SourceStatus;
  egress: EgressMode;
  egress_auto: boolean;
  egress_locked: boolean;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_entry_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  is_canary: boolean;
  added_via: AddedVia;
  note: string | null;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
}

const SOURCE_COLUMNS =
  'id, kind, site_url, feed_url, path_prefix, foundation, project, content_category, ' +
  'status, egress, egress_auto, egress_locked, last_run_at, last_ok_at, last_entry_at, ' +
  'last_error, consecutive_failures, is_canary, added_via, note, deactivated_at, created_at, updated_at';

export interface FeedCandidate {
  feed_url: string;
  found_via: string;
  kind: string;
  feed_title: string;
  entry_count: number;
  newest_entry_at: string | null;
  cross_domain: boolean;
  is_root_index: boolean;
}

export interface ResolveResult {
  site_url: string;
  candidates: FeedCandidate[];
  errors: string[];
}

export interface CreateSourceBody {
  site_url: string;
  feed_url?: string | null;
  kind?: SourceKind;
  path_prefix?: string | null;
  foundation?: string | null;
  project?: string | null;
  content_category?: string | null;
  note?: string | null;
  is_canary?: boolean;
  egress?: EgressMode;
}

export interface PatchSourceBody {
  status?: SourceStatus;
  egress?: EgressMode;
  egress_locked?: boolean;
  foundation?: string;
  project?: string;
  content_category?: string | null;
  note?: string | null;
  is_canary?: boolean;
  feed_url?: string | null;
  path_prefix?: string | null;
  kind?: SourceKind;
}

export interface RunResult {
  job_id: number;
  scraper_id: string;
}

export interface ListSourcesFilters {
  status?: SourceStatus | '';
  foundation?: string;
  q?: string;
}

export class DiscoveryApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DiscoveryApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * getApiBaseUrl() already ends in /api (`${VITE_API_URL}/api`, or bare '/api'
 * behind the dev proxy). Routes are registered as /api/admin/content-sources/...,
 * so join tolerantly rather than double the prefix.
 */
function apiUrl(path: string): string {
  const base = getApiBaseUrl().replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return base.endsWith('/api') ? `${base}${p.replace(/^\/api/, '')}` : `${base}${p}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // The api shares no parent domain with the admin host, so the session
  // cookie does not ride along; the access token goes in a header.
  const { data: { session } } = await supabase.auth.getSession();
  const authHeader: Record<string, string> = session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
  const res = await fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader,
      ...(init.headers ?? {}),
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const env = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new DiscoveryApiError(
      res.status,
      env?.code ?? `http_${res.status}`,
      env?.message ?? res.statusText ?? `HTTP ${res.status}`,
      env?.details,
    );
  }
  return body as T;
}

/** Escape PostgREST LIKE wildcards so a filter value matches literally. */
function escapeLike(v: string): string {
  return v.replace(/[%_\\]/g, (c) => `\\${c}`);
}

/**
 * List sources, ordered by foundation then project. status and foundation
 * filter server-side; the free-text `q` is matched in process (the registry
 * is a few hundred rows and user input never goes into a PostgREST `.or()`).
 */
export async function listSources(filters: ListSourcesFilters = {}): Promise<DiscoverySource[]> {
  let query = supabase
    .from('discovery_sources')
    .select(SOURCE_COLUMNS)
    .order('foundation')
    .order('project')
    .limit(2000);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.foundation) query = query.ilike('foundation', escapeLike(filters.foundation.trim()));
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as DiscoverySource[];
  const needle = filters.q?.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) =>
    [r.project, r.foundation, r.feed_url, r.site_url, r.note].some(
      (v) => typeof v === 'string' && v.toLowerCase().includes(needle),
    ),
  );
}

/** Run the resolver against a site URL. No write. */
export function resolveSite(siteUrl: string): Promise<ResolveResult> {
  return request<ResolveResult>('/admin/content-sources/resolve', {
    method: 'POST',
    body: JSON.stringify({ site_url: siteUrl }),
  });
}

/** Create a source. Admin callers land a same-domain feed or sitemap as `active`; cross-domain feeds and `html` sites stay pending. */
export async function createSource(body: CreateSourceBody): Promise<DiscoverySource> {
  const r = await request<{ source: DiscoverySource }>('/admin/content-sources/sources', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return r.source;
}

/** Change allowlisted fields. Sending egress 'direct' locks the row server-side. */
export async function patchSource(id: string, body: PatchSourceBody): Promise<DiscoverySource> {
  const r = await request<{ source: DiscoverySource }>(`/admin/content-sources/sources/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return r.source;
}

/** Enqueue the FeedScraper for one source. */
export function runSource(id: string): Promise<RunResult> {
  return request<RunResult>(`/admin/content-sources/sources/${encodeURIComponent(id)}/run`, { method: 'POST' });
}

/** Enqueue the FeedScraper for every active source. */
export function runAll(): Promise<RunResult> {
  return request<RunResult>('/admin/content-sources/run', { method: 'POST' });
}

/** Distinct foundations in the order they first appear (the list is already sorted by foundation). */
export function distinctFoundations(rows: DiscoverySource[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.foundation) seen.add(r.foundation);
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}
