/**
 * Client for the speaker dedupe review endpoints.
 *
 * Mounted under /api/modules/event-speakers, which the platform gates to
 * super_admin. That is deliberate: merging two speaker records rewrites who
 * gave which talk across every event they appear on.
 */

import { supabase } from '@/lib/supabase';

const BASE = '/api/modules/event-speakers';

export interface DedupeProfile {
  id: string;
  name: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  linkedin_url: string | null;
  avatar_url: string | null;
  sched_user_id: string | null;
  created_at: string | null;
}

export interface DedupeCandidate {
  id: string;
  profile_ids: string[];
  canonical_id: string;
  rule: string;
  reason: string;
  score: number;
  signals: Record<string, unknown>;
  state: 'open' | 'merged' | 'rejected';
  created_at: string;
  profiles: DedupeProfile[];
}

export interface DedupeSummary {
  candidates: { open: number; merged: number; rejected: number };
  merged_profiles: number;
}

function apiUrl(): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
  return base.replace(/\/+$/, '');
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
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

export async function getSummary(): Promise<DedupeSummary> {
  return jsonOrThrow<DedupeSummary>(await authedFetch(`${BASE}/admin/speaker-dedupe/summary`));
}

export async function listCandidates(
  state: 'open' | 'merged' | 'rejected' = 'open',
  limit = 50,
): Promise<DedupeCandidate[]> {
  const res = await authedFetch(`${BASE}/admin/speaker-dedupe/candidates?state=${state}&limit=${limit}`);
  const body = await jsonOrThrow<{ candidates: DedupeCandidate[] }>(res);
  return body.candidates ?? [];
}

/** Merge a candidate. `canonicalId` must be one of the profiles in the group. */
export async function mergeCandidate(id: string, canonicalId?: string): Promise<void> {
  await jsonOrThrow(await authedFetch(`${BASE}/admin/speaker-dedupe/candidates/${id}/merge`, {
    method: 'POST',
    body: JSON.stringify(canonicalId ? { canonical_id: canonicalId } : {}),
  }));
}

export async function rejectCandidate(id: string): Promise<void> {
  await jsonOrThrow(await authedFetch(`${BASE}/admin/speaker-dedupe/candidates/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({}),
  }));
}

/** Undo a merge. Restores exactly the junction rows that moved. */
export async function unmerge(aliasId: string): Promise<void> {
  await jsonOrThrow(await authedFetch(`${BASE}/admin/speaker-dedupe/unmerge`, {
    method: 'POST',
    body: JSON.stringify({ alias_id: aliasId }),
  }));
}

/** Queue the sweep. Defaults to planning only. */
export async function runSweep(dryRun = true): Promise<{ job_id?: string }> {
  return jsonOrThrow<{ job_id?: string }>(await authedFetch(`${BASE}/admin/speaker-dedupe/run`, {
    method: 'POST',
    body: JSON.stringify({ dry_run: dryRun }),
  }));
}

/** Queue LinkedIn lookups for duplicate-named speakers who have none. */
export async function runLinkedinEnrichment(limit = 100): Promise<{ job_id?: string }> {
  return jsonOrThrow<{ job_id?: string }>(await authedFetch(`${BASE}/admin/speaker-dedupe/enrich-linkedin`, {
    method: 'POST',
    body: JSON.stringify({ limit, duplicates_only: true }),
  }));
}

/** Plain-English label for a rule, so the queue explains itself. */
export function ruleLabel(rule: string): string {
  const map: Record<string, string> = {
    linkedin_contradicts: 'Different LinkedIn profiles',
    sched_contradicts: 'Different sched accounts',
    name_not_specific: 'Only a first name',
    names_differ: 'Names differ',
    name_only: 'Same name, no shared ID',
  };
  return map[rule.replace(/^review:/, '')] ?? rule;
}
