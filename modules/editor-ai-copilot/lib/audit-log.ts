/**
 * Audit-log writer for canvas_ai_audit_log. One row per AI request
 * attempt (success or failure). Persisted via service-role; the table
 * also powers the 24h per-user quota in rate-limiter.ts.
 */

import type { AuditStatus, GenerateMode, HostKind, ProviderName } from './types.js';
import type { FetchedUrlAuditEntry, WebSearchAuditEntry } from './web-tools/types.js';

export interface AuditRow {
  hostKind: HostKind;
  hostId: string;
  targetId: string;
  blockId: string | null;
  userId: string;
  prompt: string;
  mode: GenerateMode;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  status: AuditStatus;
  blocksReturned: number;
  blocksDropped: number;
  docIds: ReadonlyArray<string>;
  warnings: ReadonlyArray<unknown>;
  /** AI Skills applied to this generation, in priority order. */
  activeSkillIds?: ReadonlyArray<string>;
  /** content_hash of each skill at time of generation — for tracing. */
  activeSkillHashes?: ReadonlyArray<string>;
  /** Per-skill truncation / drop record. Shape: { id, included_chars, original_chars, status }. */
  activeSkillTruncations?: ReadonlyArray<{
    id: string;
    included_chars: number;
    original_chars: number;
    status: 'truncated' | 'dropped';
  }>;
  /** Per-turn web_search invocations (spec-ai-chatbot-web-search.md §4). */
  webSearches?: ReadonlyArray<WebSearchAuditEntry>;
  /** Per-turn fetch_url invocations (spec-ai-chatbot-web-search.md §4). */
  fetchedUrls?: ReadonlyArray<FetchedUrlAuditEntry>;
}

// Structural Supabase surface — keep in sync with the SupabaseLike
// declared in api/generate.ts so the same client object satisfies both.
interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: any | null }>;
}

export async function insertAuditRow(
  supabase: SupabaseLike,
  row: AuditRow,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (supabase.from('canvas_ai_audit_log') as any)
      .insert({
        host_kind: row.hostKind,
        host_id: row.hostId,
        target_id: row.targetId,
        block_id: row.blockId,
        user_id: row.userId,
        prompt: row.prompt,
        mode: row.mode,
        provider: row.provider,
        model: row.model,
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        duration_ms: row.durationMs,
        status: row.status,
        blocks_returned: row.blocksReturned,
        blocks_dropped: row.blocksDropped,
        doc_ids: row.docIds,
        warnings: row.warnings,
        active_skill_ids: row.activeSkillIds ?? [],
        active_skill_hashes: row.activeSkillHashes ?? [],
        active_skill_truncations: row.activeSkillTruncations ?? [],
        web_searches: row.webSearches ?? [],
        fetched_urls: row.fetchedUrls ?? [],
      })
      .select('id')
      .single();
    if (result.error) {
      return { ok: false, error: result.error.message ?? 'audit_insert_failed' };
    }
    const id = (result.data as { id: string } | null)?.id ?? '';
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Count audit rows for a user in the last N hours — supports the
 * 24h per-user quota (§4.3 third row). Used by rate-limiter.ts.
 */
export async function countUserAuditRows(
  supabase: SupabaseLike,
  userId: string,
  windowMs: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = await (supabase.from('canvas_ai_audit_log') as any)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since);
  if (q.error) return 0;
  return q.count ?? 0;
}
