/**
 * Browser-side fetch wrapper for /admin/jobs/* + SSE streams.
 *
 * Spec: spec-ai-job-runner §5.
 */

import { supabase } from '@/lib/supabase';

const API_URL =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  return fetch(`${API_URL}${path}`, { ...init, headers });
}

export type JobStatus = 'active' | 'waiting' | 'delayed' | 'failed' | 'completed';

export interface AdminJobDto {
  id: string;
  name: string;
  status: JobStatus;
  attempts_made: number;
  attempts_remaining: number;
  created_at: string;
  processed_on: string | null;
  finished_on: string | null;
  /**
   * Wall-clock time at which a `delayed` job will be promoted to the
   * wait queue. Null for non-delayed states. Used by the admin UI to
   * render "Fires in 2m" rather than "Delayed 32m ago", which was
   * showing the descriptor age (misleading — looked like overdue).
   */
  scheduled_for: string | null;
  data: Record<string, unknown>;
  failed_reason: string | null;
  stacktrace: string[] | null;
  owner_module: string;
  linked_row: { table: string; id: string } | null;
  stream_key: string | null;
  stream_offset_latest: string | null;
}

export interface ListJobsOpts {
  status?: JobStatus[];
  type?: string;
  limit?: number;
  offset?: number;
}

export interface ServiceError {
  code: string;
  message: string;
  httpStatus: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

async function parseError(res: Response): Promise<ServiceError> {
  let body: { error?: { code?: string; message?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-json */
  }
  return {
    code: body.error?.code ?? `http_${res.status}`,
    message: body.error?.message ?? `Request failed (${res.status})`,
    httpStatus: res.status,
  };
}

export const JobsService = {
  async list(opts: ListJobsOpts = {}): Promise<Result<{ jobs: AdminJobDto[]; total: number }>> {
    const qs = new URLSearchParams();
    if (opts.status?.length) qs.set('status', opts.status.join(','));
    if (opts.type) qs.set('type', opts.type);
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.offset) qs.set('offset', String(opts.offset));
    const r = await authedFetch(`/api/modules/ai/admin/jobs${qs.toString() ? '?' + qs : ''}`);
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as { jobs: AdminJobDto[]; total: number } };
  },

  async get(id: string): Promise<Result<AdminJobDto>> {
    const r = await authedFetch(`/api/modules/ai/admin/jobs/${encodeURIComponent(id)}`);
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: (await r.json()) as AdminJobDto };
  },

  async stop(id: string): Promise<Result<undefined>> {
    const r = await authedFetch(`/api/modules/ai/admin/jobs/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: undefined };
  },

  async retry(id: string): Promise<Result<undefined>> {
    const r = await authedFetch(`/api/modules/ai/admin/jobs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: undefined };
  },

  async promote(id: string): Promise<Result<undefined>> {
    const r = await authedFetch(`/api/modules/ai/admin/jobs/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
    });
    if (!r.ok) return { ok: false, error: await parseError(r) };
    return { ok: true, value: undefined };
  },

  /**
   * Open an SSE EventSource to a job's stream. The browser's
   * EventSource auto-reconnects with Last-Event-ID; we set the initial
   * `offset=` query if the caller has a known cursor.
   */
  streamUrl(jobId: string, offset?: string): string {
    const qs = offset ? `?offset=${encodeURIComponent(offset)}` : '';
    return `${API_URL}/api/modules/ai/admin/jobs/${encodeURIComponent(jobId)}/stream${qs}`;
  },
};
