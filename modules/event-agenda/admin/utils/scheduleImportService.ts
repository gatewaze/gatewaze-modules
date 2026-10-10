/**
 * Client for the schedule-import admin endpoints
 * (spec-event-agenda-schedule-import §10).
 *
 * These go over HTTP rather than straight to Supabase like the module's other
 * admin services: triggering an import enqueues a job, and the two import
 * tables are deliberately service-role write (admin read only), so the writes
 * have to pass through the API.
 */

import { supabase } from '@/lib/supabase';

export type ScheduleImportStatus = 'pending' | 'unavailable' | 'importing' | 'complete' | 'failed';

export interface ScheduleImportStats {
  sessions?: number;
  breaks?: number;
  tracks?: number;
  speakers?: number;
  speakers_created?: number;
  speakers_adopted?: number;
  preserved_edits?: number;
  skeleton_mismatch?: number;
  unchanged?: boolean;
  stale?: string[];
}

export interface ScheduleImport {
  event_uuid: string;
  source_kind: string;
  schedule_url: string | null;
  resolved_source_url: string | null;
  url_origin: 'event' | 'manual';
  status: ScheduleImportStatus;
  content_hash: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  error: string | null;
  stats: ScheduleImportStats;
}

export interface ScheduleImportState {
  import: ScheduleImport | null;
  /** What the importer would use if run now, when nothing has run yet. */
  candidate_source_url: string | null;
  has_run: boolean;
}

const BASE = '/api/modules/event-agenda';

function apiUrl(): string {
  return (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function getScheduleImport(eventUuid: string): Promise<ScheduleImportState> {
  const res = await authedFetch(`${BASE}/admin/events/${eventUuid}/schedule-import`);
  return jsonOrThrow<ScheduleImportState>(res);
}

/** Pass null to clear the override and fall back to the event's own link. */
export async function setScheduleSource(eventUuid: string, scheduleUrl: string | null): Promise<void> {
  const res = await authedFetch(`${BASE}/admin/events/${eventUuid}/schedule-source`, {
    method: 'PUT',
    body: JSON.stringify({ schedule_url: scheduleUrl }),
  });
  await jsonOrThrow(res);
}

/** Queue an import. `force` re-reads even when the programme is unchanged. */
export async function runScheduleImport(eventUuid: string, force = false): Promise<{ job_id?: string }> {
  const res = await authedFetch(`${BASE}/admin/events/${eventUuid}/schedule-import`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
  return jsonOrThrow<{ job_id?: string }>(res);
}

/** Human summary of a finished import, for the card's one-line result. */
export function describeStats(stats: ScheduleImportStats | undefined): string {
  if (!stats) return '';
  if (stats.unchanged) return 'Programme unchanged since the last import.';
  const bits: string[] = [];
  if (stats.sessions != null) bits.push(`${stats.sessions} session${stats.sessions === 1 ? '' : 's'}`);
  if (stats.breaks != null) bits.push(`${stats.breaks} break${stats.breaks === 1 ? '' : 's'}`);
  if (stats.speakers != null) bits.push(`${stats.speakers} speaker${stats.speakers === 1 ? '' : 's'}`);
  if (stats.speakers_created) bits.push(`${stats.speakers_created} new`);
  if (stats.preserved_edits) bits.push(`${stats.preserved_edits} edit${stats.preserved_edits === 1 ? '' : 's'} kept`);
  return bits.join(' · ');
}
