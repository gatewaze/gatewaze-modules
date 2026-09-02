// @ts-nocheck — supabase-js types are resolved at module-host install time.
/**
 * GlockApps client (Spamtest v2 API) and shared runtime helpers.
 *
 * Written against the published OpenAPI spec at
 * https://docs.spamtest.prod-k8s.glockapps.com/swagger.json — every call is
 * project-scoped and authenticated with an `x-api-key` header, NOT a bearer
 * token.
 *
 * The model is test-scoped, not list-scoped: there is no standing seed list to
 * fetch. You create a test, GlockApps hands back the seed addresses to send to
 * plus a tracking code, you send, then you read the result off that test. The
 * module's flow follows that shape.
 *
 * 401/403 is treated as terminal rather than transient: GlockApps gates API
 * access by plan, so retrying a rejected key forever is pointless. Callers fall
 * back to manual entry instead.
 */

import { createClient } from '@supabase/supabase-js';
import { normalisePlacement } from './placement-parse';
import type { PlacementResult, ProviderPlacement } from './placement-parse';

export const MODULE_ID = 'send-testing-glockapps';
export const SEND_TESTING_LIST_ID = '5e4d0000-0000-0000-0000-000000000001';
export const SEED_LIST_ID = '5e4d0000-0000-0000-0000-000000000002';

const API_BASE = 'https://api.glockapps.com/gateway/spamtest-v2/api';
const REQUEST_TIMEOUT_MS = 20_000;

let _service: ReturnType<typeof createClient> | null = null;

export function serviceClient() {
  if (_service) return _service;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('send-testing-glockapps: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  _service = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _service;
}

export interface GlockAppsConfig {
  apiKey: string;
  projectId: string;
  seedListMode: 'shared' | 'separate';
}

export async function loadConfig(supabase = serviceClient()): Promise<GlockAppsConfig> {
  const { data } = await supabase
    .from('installed_modules')
    .select('config')
    .eq('id', MODULE_ID)
    .maybeSingle();
  const raw = (data?.config ?? {}) as Record<string, unknown>;
  return {
    apiKey: String(raw.api_key ?? '').trim(),
    projectId: String(raw.project_id ?? '').trim(),
    seedListMode: raw.seed_list_mode === 'separate' ? 'separate' : 'shared',
  };
}

export function targetListId(config: GlockAppsConfig): string {
  return config.seedListMode === 'separate' ? SEED_LIST_ID : SEND_TESTING_LIST_ID;
}

/** Distinguishes "your plan/key cannot do this" from "try again later". */
export class GlockAppsAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlockAppsAccessError';
  }
}

async function request<T>(
  config: GlockAppsConfig,
  path: string,
  init?: RequestInit & { skipProjectCheck?: boolean },
): Promise<T> {
  if (!config.apiKey) {
    throw new GlockAppsAccessError('No GlockApps API key configured (manual mode)');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'x-api-key': config.apiKey,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });

    if (res.status === 401 || res.status === 403) {
      // Terminal for this key/plan. GlockApps gates API access by tier, so
      // retrying cannot help — surface it and let the caller fall back.
      throw new GlockAppsAccessError(
        `GlockApps rejected the API key (${res.status}). The plan may not include API access; use manual entry.`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GlockApps request failed (${res.status}): ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface GlockAppsProject {
  id: string;
  name: string;
}

/** Also the cheapest way to verify a key and plan tier without spending a test. */
export async function listProjects(config: GlockAppsConfig): Promise<GlockAppsProject[]> {
  const body = await request<{ results?: { id?: string; name?: string }[] }>(config, '/projects');
  return (body?.results ?? []).map((p) => ({
    id: String(p?.id ?? ''),
    name: String(p?.name ?? ''),
  }));
}

export interface ManualTestStart {
  testId: string;
  /** The seed addresses to send to. These ARE the seed list for this test. */
  emails: string[];
  /** GlockApps correlation code. One of these must reach the message for the
   *  test to be matched reliably — the module cannot inject it, so the operator
   *  has to paste it into the campaign. */
  insertHeader: string;
  insertInBody: string;
}

export async function startManualTest(
  config: GlockAppsConfig,
  params: { note?: string },
): Promise<ManualTestStart> {
  if (!config.projectId) {
    throw new Error('send-testing-glockapps: project_id is not configured');
  }
  const body = await request<{
    testId?: string;
    emails?: string[];
    insertHeader?: string;
    insertInBody?: string;
  }>(config, `/projects/${encodeURIComponent(config.projectId)}/manualTest`, {
    method: 'POST',
    body: JSON.stringify({ note: params.note ?? 'Gatewaze send-testing', testType: 'manual' }),
  });

  const testId = String(body?.testId ?? '').trim();
  if (!testId) throw new Error('GlockApps did not return a test id');

  return {
    testId,
    emails: Array.isArray(body?.emails) ? body.emails.map((e) => String(e).trim().toLowerCase()) : [],
    insertHeader: String(body?.insertHeader ?? ''),
    insertInBody: String(body?.insertInBody ?? ''),
  };
}

export { normalisePlacement };
export type { PlacementResult, ProviderPlacement };

/**
 * Fetch one test's results.
 *
 * `GET /projects/{id}/tests` is a SINGLE-test fetch keyed by a `testId` query
 * parameter, not a list — calling it without one returns 404 "test not found",
 * which is what an earlier version of this client did on every poll. The list
 * endpoints are `/tests/list` and `/shortTestResults`; neither is needed here
 * because we always know the id we started.
 */
export async function fetchTestResults(
  config: GlockAppsConfig,
  testId: string,
): Promise<PlacementResult> {
  if (!config.projectId) {
    throw new Error('send-testing-glockapps: project_id is not configured');
  }

  const path =
    `/projects/${encodeURIComponent(config.projectId)}/tests` +
    `?testId=${encodeURIComponent(testId)}`;

  let body: { result?: unknown };
  try {
    body = await request<{ result?: unknown }>(config, path);
  } catch (err) {
    // A test that GlockApps has not registered yet answers 404. That is a
    // normal early state, not a failure worth stopping the poll for.
    if (err instanceof Error && /\(404\)/.test(err.message)) {
      return { complete: false, providers: [], auth: null, raw: null };
    }
    throw err;
  }

  if (!body?.result) {
    return { complete: false, providers: [], auth: null, raw: body };
  }
  return normalisePlacement(body.result);
}
