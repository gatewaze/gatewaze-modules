/**
 * Admin-side client for the webhooks module's REST surface.
 *
 * The endpoints live under /api/admin/sites/:siteId/webhook-subscriptions/...
 * and require the admin's bearer token. Secrets are masked on read; we get
 * the cleartext exactly once on create + on rotate, and surface it to the
 * operator immediately so they can paste it into the subscriber's env.
 *
 * Topics come straight from Supabase because the `webhook_event_topics`
 * table has an `authenticated read` RLS policy and no admin write surface;
 * a dedicated endpoint would be over-engineering for v1.
 */

import { supabase } from '@/lib/supabase';

export type WebhookSubscriptionStatus = 'enabled' | 'disabled' | 'suspended';

export interface WebhookSubscription {
  id: string;
  host_kind: 'site' | 'list' | 'newsletter' | 'global';
  host_id: string;
  url: string;
  topics: string[];
  status: WebhookSubscriptionStatus;
  secret: string; // always '<redacted>' on read
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookSubscriptionInput {
  url: string;
  topics: string[];
  status?: WebhookSubscriptionStatus;
}

export interface WebhookEventTopic {
  topic: string;
  surrogate_key_template: string;
  detail_key_template: string | null;
  description: string | null;
}

export interface WebhookTestResult {
  url: string;
  status: number;
  duration_ms: number;
  response_body_preview: string;
  error: string | null;
}

function apiUrl(): string {
  return (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
}

async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const res = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.message) detail = body.message;
      else if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function listWebhookSubscriptions(
  siteId: string,
): Promise<WebhookSubscription[]> {
  const res = await authedFetch(`/api/admin/sites/${siteId}/webhook-subscriptions`);
  const body = await jsonOrThrow<{ subscriptions: WebhookSubscription[] }>(res);
  return body.subscriptions;
}

export interface CreateWebhookSubscriptionResult {
  subscription: WebhookSubscription;
  /** Cleartext secret — shown to the operator ONCE on create. */
  secret: string;
}

export async function createWebhookSubscription(
  siteId: string,
  input: WebhookSubscriptionInput,
): Promise<CreateWebhookSubscriptionResult> {
  const res = await authedFetch(`/api/admin/sites/${siteId}/webhook-subscriptions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow<CreateWebhookSubscriptionResult>(res);
}

export async function updateWebhookSubscription(
  siteId: string,
  id: string,
  patch: Partial<WebhookSubscriptionInput>,
): Promise<WebhookSubscription> {
  const res = await authedFetch(
    `/api/admin/sites/${siteId}/webhook-subscriptions/${id}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  const body = await jsonOrThrow<{ subscription: WebhookSubscription }>(res);
  return body.subscription;
}

export async function deleteWebhookSubscription(
  siteId: string,
  id: string,
): Promise<void> {
  const res = await authedFetch(
    `/api/admin/sites/${siteId}/webhook-subscriptions/${id}`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`HTTP ${res.status}`);
  }
}

export interface RotateSecretResult {
  secret: string;
  rotated_at: string;
}

export async function rotateWebhookSecret(
  siteId: string,
  id: string,
): Promise<RotateSecretResult> {
  const res = await authedFetch(
    `/api/admin/sites/${siteId}/webhook-subscriptions/${id}/rotate-secret`,
    { method: 'POST' },
  );
  return jsonOrThrow<RotateSecretResult>(res);
}

export async function sendWebhookTest(
  siteId: string,
  id: string,
): Promise<WebhookTestResult> {
  const res = await authedFetch(
    `/api/admin/sites/${siteId}/webhook-subscriptions/${id}/test`,
    { method: 'POST' },
  );
  return jsonOrThrow<WebhookTestResult>(res);
}

export async function listWebhookEventTopics(): Promise<WebhookEventTopic[]> {
  const { data, error } = await supabase
    .from('webhook_event_topics')
    .select('topic, surrogate_key_template, detail_key_template, description')
    .order('topic', { ascending: true });
  if (error) throw error;
  return (data ?? []) as WebhookEventTopic[];
}

/**
 * Pick the most-recently-created site. Dev DBs accumulate stub sites
 * from earlier testing; the active site is the most recent. Replace
 * with a proper site picker once the admin grows multi-site UX.
 */
export async function getDefaultSiteId(): Promise<string | null> {
  const { data, error } = await supabase
    .from('sites')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as { id?: string } | null)?.id ?? null;
}
