/**
 * Admin client for the research routes (api/research-routes.ts), mounted on
 * the newsletters admin router at /api/admin/newsletters/... behind bearer
 * auth. Same join as content-platform's inboxService: getApiBaseUrl() + path,
 * the admin's Supabase access token in the Authorization header.
 */

import { getApiBaseUrl } from '@/config/brands';
import { supabase } from '@/lib/supabase';

export type ResearchRunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type ResearchFailureKind = 'cost_cap' | 'recipe' | 'input' | 'stale' | 'output_invalid' | 'other';

export interface ResearchRun {
  id: string;
  block_id: string;
  status: ResearchRunStatus;
  failure_kind: ResearchFailureKind | null;
  triggered_by: 'schedule' | 'manual' | 'daily' | 'revert';
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  cost_micro_usd: number;
  error: string | null;
  ai_thread_id: string | null;
  binding_hash?: string;
  input_summary?: Record<string, unknown> | null;
  seq: number;
}

export interface SendGate {
  allowed: boolean;
  reason_code: 'OK' | 'NO_RESEARCH_RUN' | 'RESEARCH_IN_PROGRESS' | 'COST_CAP_BREACH' | string;
  block_id: string | null;
}

export interface EditionResearch {
  blocks: Array<{ id: string; def_id: string; binding: Record<string, unknown>; latest_run: ResearchRun | null }>;
  gate: SendGate | null;
  effective_research_at: string | null;
  /** Research may still change this edition: a draft, or published and not yet sending (newsletters_edition_research_open). */
  research_open?: boolean;
}

/**
 * getApiBaseUrl() usually ends in /api (`${VITE_API_URL}/api`, or bare '/api'),
 * while these routes are registered as /api/admin/newsletters/...: join without
 * doubling the prefix. Same helper as content-sources' discoveryService.
 */
function apiUrl(path: string): string {
  const base = getApiBaseUrl().replace(/\/+$/, '');
  return base.endsWith('/api') ? `${base}${path.replace(/^\/api/, '')}` : `${base}${path}`;
}

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const r = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: { code?: string; message?: string } | string } | null;
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
    throw Object.assign(new Error(message || `Request failed (${r.status})`), {
      code: typeof body?.error === 'object' && body?.error?.code ? body.error.code : `http_${r.status}`,
      status: r.status,
    });
  }
  return r.json() as Promise<T>;
}

const enc = encodeURIComponent;

export const researchService = {
  edition: (editionId: string) => jfetch<EditionResearch>(`/api/admin/newsletters/editions/${enc(editionId)}/research`),
  runs: (editionId: string) => jfetch<{ runs: ResearchRun[] }>(`/api/admin/newsletters/editions/${enc(editionId)}/research/runs`),
  run: (editionId: string, blockId?: string) =>
    jfetch<{ queued: string[]; busy: string[] }>(`/api/admin/newsletters/editions/${enc(editionId)}/research/run`, {
      method: 'POST',
      body: JSON.stringify(blockId ? { block_id: blockId } : {}),
    }),
  cancel: (runId: string) => jfetch<{ cancelled: string }>(`/api/admin/newsletters/research/runs/${enc(runId)}/cancel`, { method: 'POST', body: '{}' }),
  revert: (runId: string) => jfetch<{ run_id: string; version: number | null }>(`/api/admin/newsletters/research/runs/${enc(runId)}/revert`, { method: 'POST', body: '{}' }),
};

/** The gate's reason in words. `blockName` is the offending block's label when known. */
export function sendGateMessage(code: string, blockName?: string | null): string {
  const block = blockName ? `"${blockName}"` : 'a research block';
  switch (code) {
    case 'NO_RESEARCH_RUN': return `Research has not run yet for ${block}. Run it from the block's Research panel (this works on a published edition too), or remove the block.`;
    case 'RESEARCH_IN_PROGRESS': return `Research is still running for ${block}. Wait for it to finish (or cancel it) before sending.`;
    case 'COST_CAP_BREACH': return `Research failed on its cost cap for ${block}; raise the cap and re-run, or remove the block.`;
    default: return `This edition cannot be sent yet (${code}).`;
  }
}

/** Parse the DB trigger's `SEND_GATE:<code>:<block>` message; null for any other error. */
export function parseSendGateError(message: string | null | undefined): { code: string; block_id: string | null } | null {
  const m = /SEND_GATE:([A-Z_]+):([0-9a-f-]+|<NULL>|)/i.exec(message ?? '');
  if (!m) return null;
  const block = m[2] && /^[0-9a-f-]{36}$/i.test(m[2]) ? m[2] : null;
  return { code: m[1], block_id: block };
}
