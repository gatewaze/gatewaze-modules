/**
 * Calls to the slack module's welcome-DM routes (super_admin, platform-gated).
 *
 * Plain fetch with the session's bearer token: supabase-js `.rpc()` has no
 * headers option, so it cannot carry the admin's JWT to the API host.
 * The filename is deliberately specific — admin/utils/<name>.ts becomes a
 * global @/utils/<name> alias and the first module to claim a name wins.
 */

import { getApiConfig } from '@/config/brands';

export interface WelcomeSender {
  team_id: string;
  slack_user_id: string;
  slack_user_name: string | null;
  scopes: string | null;
  connected_at: string;
  status: 'connected' | 'broken';
  status_detail: string | null;
}

export interface WelcomeStatus {
  setup: Record<'client_id' | 'client_secret' | 'signing_secret' | 'bot_token' | 'secrets_key' | 'api_url', boolean>;
  urls: { events: string; redirect: string };
  user_scopes: string[];
  sender: WelcomeSender | null;
  settings: { enabled: boolean; message: string; delay_minutes: number };
  defaults: { message: string; delay_minutes: number };
  last_30_days: Record<string, number>;
}

export interface WelcomeLogRow {
  id: string;
  slack_user_id: string;
  email: string | null;
  first_name: string | null;
  display_name: string | null;
  person_id: string | null;
  joined_at: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  skip_reason: string | null;
  error: string | null;
  attempts: number;
  sent_at: string | null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { supabase } = await import('@/lib/supabase');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** `path` is relative to the API base, which already ends in /api. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiConfig().baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body as T;
}

export type PeopleSyncMode = 'off' | 'link' | 'create';

export interface MemberSyncRun {
  id: string;
  mode: 'link' | 'create';
  status: 'queued' | 'running' | 'done' | 'failed';
  started_at: string | null;
  finished_at: string | null;
  pages: number;
  members_seen: number;
  results: Record<string, number>;
  error: string | null;
  created_at: string;
}

export interface MemberSyncStatus {
  mode: PeopleSyncMode;
  linked_people: number | null;
  runs: MemberSyncRun[];
}

const W = '/modules/slack/welcome';
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) });

export const slackWelcome = {
  status: () => call<WelcomeStatus>(`${W}/status`),
  log: () => call<{ rows: WelcomeLogRow[] }>(`${W}/log`),
  connectLink: (email: string) =>
    call<{ authorize_url: string; for: { id: string; name: string }; expires_at: string }>(`${W}/connect-link`, post({ email })),
  disconnect: () => call<{ ok: true }>(`${W}/disconnect`, post({})),
  test: (email: string, message: string) => call<{ ok: true; to: string; from: string }>(`${W}/test`, post({ email, message })),
  retry: (includeFailed: boolean) => call<{ ok: true; queued: number }>(`${W}/retry`, post({ include_failed: includeFailed })),
  membersSync: () => call<MemberSyncStatus>(`${W}/members-sync`),
  startMembersSync: () => call<{ ok: true; id: string; mode: PeopleSyncMode }>(`${W}/members-sync`, post({})),
  savePeopleSync: (mode: PeopleSyncMode) =>
    call<{ success: boolean }>(`/modules/slack/config`, {
      method: 'PUT',
      body: JSON.stringify({ config: { SLACK_PEOPLE_SYNC: mode } }),
    }),
  /** Saved through the platform's module-config route, which merges keys and seals secret fields. */
  saveSettings: (s: { enabled: boolean; message: string; delay_minutes: number }) =>
    call<{ success: boolean }>(`/modules/slack/config`, {
      method: 'PUT',
      body: JSON.stringify({
        config: {
          SLACK_WELCOME_ENABLED: s.enabled,
          SLACK_WELCOME_MESSAGE: s.message,
          SLACK_WELCOME_DELAY_MINUTES: s.delay_minutes,
        },
      }),
    }),
};
