// @ts-nocheck — supabase-js types are resolved at module-host install time.
/**
 * GlockApps client and shared runtime helpers.
 *
 * The API surface is deliberately thin and defensive. GlockApps' plan tiering
 * for API access is not reliably documented and the two sources checked
 * disagree, so every call has to treat 401/403 as "this plan does not allow it"
 * rather than as a transient error — the module then falls back to manual entry
 * instead of retrying forever against a tier that will never answer.
 */

import { createClient } from '@supabase/supabase-js';
import { normalisePlacement } from './placement-parse';
import { isPlausibleEmail } from './email';
import type { PlacementResult, ProviderPlacement } from './placement-parse';

export const MODULE_ID = 'send-testing-glockapps';
export const SEND_TESTING_LIST_ID = '5e4d0000-0000-0000-0000-000000000001';
export const SEED_LIST_ID = '5e4d0000-0000-0000-0000-000000000002';

const API_BASE = 'https://api.glockapps.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;

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
    seedListMode: raw.seed_list_mode === 'separate' ? 'separate' : 'shared',
  };
}

export function targetListId(config: GlockAppsConfig): string {
  return config.seedListMode === 'separate' ? SEED_LIST_ID : SEND_TESTING_LIST_ID;
}

/** Distinguishes "your plan cannot do this" from "try again later". */
export class GlockAppsAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlockAppsAccessError';
  }
}

async function request<T>(config: GlockAppsConfig, path: string, init?: RequestInit): Promise<T> {
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
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });

    if (res.status === 401 || res.status === 403) {
      // Terminal for this plan: retrying cannot help, so surface it as an
      // access error and let the caller stop polling and fall back to manual.
      throw new GlockAppsAccessError(
        `GlockApps rejected the API key (${res.status}). This plan may not include API access; use manual entry.`,
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

export interface SeedAddress {
  email: string;
  provider?: string;
}

/**
 * Seed lists rotate, so this is a fetch-fresh operation rather than something
 * cached at install time. A stale seed list silently measures placement for
 * mailboxes GlockApps is no longer watching.
 */
export async function fetchSeedList(config: GlockAppsConfig): Promise<SeedAddress[]> {
  const body = await request<{ seeds?: { email?: string; provider?: string }[] }>(
    config,
    '/seed-list',
  );
  const seeds = Array.isArray(body?.seeds) ? body.seeds : [];
  return seeds
    .map((seed) => ({
      email: String(seed?.email ?? '').trim().toLowerCase(),
      provider: seed?.provider ? String(seed.provider).toLowerCase() : undefined,
    }))
    // Same linear check as the paste path: the response is third-party input.
    .filter((seed) => isPlausibleEmail(seed.email));
}

export async function startTest(
  config: GlockAppsConfig,
  params: { name: string },
): Promise<{ testId: string }> {
  const body = await request<{ id?: string; test_id?: string }>(config, '/tests', {
    method: 'POST',
    body: JSON.stringify({ name: params.name }),
  });
  const testId = String(body?.id ?? body?.test_id ?? '').trim();
  if (!testId) throw new Error('GlockApps did not return a test id');
  return { testId };
}

export { normalisePlacement };
export type { PlacementResult, ProviderPlacement };

export async function fetchTestResults(
  config: GlockAppsConfig,
  testId: string,
): Promise<PlacementResult> {
  const payload = await request<unknown>(config, `/tests/${encodeURIComponent(testId)}/results`);
  return normalisePlacement(payload);
}
