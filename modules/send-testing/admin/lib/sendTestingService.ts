import { supabase } from '@/lib/supabase';

const API_URL =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
const BASE = `${API_URL}/api/admin/modules/send-testing`;

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  return fetch(`${BASE}${path}`, { ...init, headers });
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: { code?: string; message?: string };
  };
  if (!res.ok) {
    throw new Error(body?.error?.message || `Request failed (${res.status})`);
  }
  return body as T;
}

function postJson<T>(path: string, payload?: unknown, method = 'POST'): Promise<T> {
  return json<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

export interface ModuleStatus {
  domain_configured: boolean;
  inbound_domain: string;
  inbound_token_set: boolean;
  inspectable_count: number;
  default_population_size: number;
  postmaster_url: string;
  snds_url: string;
  list_id: string;
  population: number;
  unsubscribed_count: number;
  job: ProvisionJob | null;
}

export interface ProvisionJob {
  id: string;
  action: 'provision' | 'deprovision' | 'resubscribe';
  state: 'running' | 'completed' | 'no_change' | 'failed';
  target_count: number | null;
  processed: number;
  last_error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ProvisionStatus {
  current_count: number;
  target_count: number | null;
  job_state: 'idle' | 'running' | 'completed' | 'no_change' | 'failed';
  processed: number;
  last_error: string | null;
  job_id: string | null;
}

export interface LatencySummary {
  p50: number;
  p90: number;
  p99: number;
  max: number;
  matched: number;
}

export interface RunResults {
  arrival_count: number;
  expected_count: number;
  completion_percent: number;
  latency_ms: LatencySummary | null;
  auth: { spf_pass: number; dkim_pass: number; dmarc_pass: number; evaluated: number };
  send_log: { queued: number; sent: number; failed: number; bounced: number } | null;
  arrivals_histogram: { bucket_start: string; count: number }[];
}

export interface SendTestRun {
  id: string;
  name: string;
  status: 'open' | 'closed' | 'archived';
  started_at: string;
  closed_at: string | null;
  expected_count: number;
  send_source: string | null;
  send_ref: string | null;
  subject_filter: string | null;
  notes: string | null;
  attribution_status: 'pending' | 'running' | 'complete' | 'failed';
  attribution_error: string | null;
  arrival_count?: number;
  results?: RunResults;
  no_sends_detected?: boolean;
  unattributed_in_window?: number;
}

export interface TestPerson {
  email: string;
  first_name: string | null;
  last_name: string | null;
  timezone: string | null;
  sequence: number | null;
  subscribed: boolean | null;
}

export interface Arrival {
  id: string;
  run_id: string | null;
  recipient_email: string;
  received_at: string;
  subject: string | null;
  headers_meta: Record<string, unknown> | null;
  body_html?: string | null;
  has_body?: boolean;
}

export const SendTestingService = {
  getStatus: () => json<ModuleStatus>('/status'),
  getProvisionStatus: () => json<ProvisionStatus>('/provision/status'),

  provision: (targetCount: number) =>
    postJson<{ job_id: string }>('/provision', { target_count: targetCount }),

  /** Omit targetCount to remove the whole synthetic population. */
  deprovision: (targetCount?: number) =>
    postJson<{ job_id: string }>(
      '/provision',
      targetCount === undefined ? {} : { target_count: targetCount },
      'DELETE',
    ),

  resubscribe: () => postJson<{ job_id: string }>('/provision/resubscribe'),

  listRuns: (params: { page?: number; pageSize?: number; status?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.page !== undefined) query.set('page', String(params.page));
    if (params.pageSize !== undefined) query.set('page_size', String(params.pageSize));
    if (params.status) query.set('status', params.status);
    const suffix = query.toString();
    return json<{ data: SendTestRun[]; total: number; page: number; page_size: number }>(
      `/runs${suffix ? `?${suffix}` : ''}`,
    );
  },

  createRun: (payload: {
    name: string;
    send_source?: string;
    send_ref?: string;
    subject_filter?: string;
    notes?: string;
  }) => postJson<SendTestRun>('/runs', payload),

  getRun: (id: string) => json<SendTestRun>(`/runs/${id}`),

  updateRun: (id: string, patch: { status?: 'closed' | 'archived'; notes?: string; subject_filter?: string | null }) =>
    postJson<SendTestRun>(`/runs/${id}`, patch, 'PATCH'),

  reattribute: (id: string) => postJson<{ queue_job_id: string }>(`/runs/${id}/attribute`),

  listPeople: () => json<{ data: TestPerson[]; inspectable_count: number }>('/people'),

  listArrivals: (email: string) =>
    json<{ data: Arrival[] }>(`/people/${encodeURIComponent(email)}/arrivals`),

  getArrival: (id: string) => json<Arrival>(`/arrivals/${id}`),

  /**
   * Streams from the server rather than assembling a blob client-side: the
   * export can run to tens of thousands of rows, and it is the handoff point
   * for external systems, so it should be one canonical file.
   */
  async downloadCsv(): Promise<void> {
    const res = await authedFetch('/people/export.csv');
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(body?.error?.message || `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `send-test-list-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  },
};

export default SendTestingService;
