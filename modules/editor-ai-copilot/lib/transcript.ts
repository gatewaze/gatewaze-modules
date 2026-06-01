/**
 * Copilot transcript <-> ai_messages mapping.
 *
 * The sidebar persists each completed turn to the ai module's
 * ai_threads / ai_messages tables so the conversation survives a page
 * reload. A turn is two rows: a `user` row (the prompt) and an
 * `assistant` row whose status label + token/cost/duration are packed
 * into the `structured` jsonb. On reload we expand each row back into
 * the sidebar's bubble sequence (status pill, optional assistant line,
 * meta line).
 *
 * This module is intentionally pure (no supabase, no node-only deps) so
 * it can be imported by both the server route and the client component,
 * and unit-tested without a DB.
 */

import type { GenerateMode } from './types.js';

export interface TranscriptUser {
  id: string;
  kind: 'user';
  text: string;
}
export interface TranscriptAssistant {
  id: string;
  kind: 'assistant';
  text: string;
}
export interface TranscriptStatus {
  id: string;
  kind: 'status';
  label: string;
  state: 'pending' | 'success' | 'error';
}
export interface TranscriptMeta {
  id: string;
  kind: 'meta';
  tokens: number;
  cost_approx: number;
  duration_ms: number;
}
export type TranscriptMessage = TranscriptUser | TranscriptAssistant | TranscriptStatus | TranscriptMeta;

/** The subset of an ai_messages row the mapping reads. */
export interface AiMessageRow {
  id: string;
  role: string;
  status?: string | null;
  content?: string | null;
  structured?: Record<string, unknown> | null;
}

/** Shape packed into `structured` on a persisted assistant turn. */
export interface CopilotAssistantStructured {
  copilot: { status_label: string; status_state: 'success' | 'error' };
  usage?: { tokens: number; cost_approx: number; duration_ms: number };
}

/** Base label per mode (matches the sidebar's statusLabelFor). */
export function statusBaseLabel(mode: GenerateMode): string {
  switch (mode) {
    case 'replace':
      return 'Replaced page';
    case 'append':
      return 'Appended blocks';
    case 'insert-after':
      return 'Inserted blocks';
    case 'edit':
      return 'Edited page';
    case 'edit-block':
      return 'Updated block';
  }
}

/**
 * Final status label for a successful turn — block-count suffix for the
 * sequence-producing modes, bare label for edit / edit-block. Mirrors
 * the live label the sidebar builds so hydrated turns read identically.
 */
export function copilotStatusLabel(mode: GenerateMode, blocksReturned: number): string {
  if (mode === 'edit-block') return 'Updated block';
  if (mode === 'edit') return 'Edited page';
  const base = statusBaseLabel(mode);
  return `${base} (${blocksReturned} block${blocksReturned === 1 ? '' : 's'})`;
}

function readStructured(row: AiMessageRow): CopilotAssistantStructured | null {
  const s = row.structured;
  if (!s || typeof s !== 'object') return null;
  const copilot = (s as { copilot?: unknown }).copilot;
  if (!copilot || typeof copilot !== 'object') return null;
  const label = (copilot as { status_label?: unknown }).status_label;
  if (typeof label !== 'string') return null;
  const rawState = (copilot as { status_state?: unknown }).status_state;
  const state: 'success' | 'error' = rawState === 'error' ? 'error' : 'success';
  const out: CopilotAssistantStructured = { copilot: { status_label: label, status_state: state } };
  const usage = (s as { usage?: unknown }).usage;
  if (usage && typeof usage === 'object') {
    const u = usage as { tokens?: unknown; cost_approx?: unknown; duration_ms?: unknown };
    if (typeof u.tokens === 'number') {
      out.usage = {
        tokens: u.tokens,
        cost_approx: typeof u.cost_approx === 'number' ? u.cost_approx : 0,
        duration_ms: typeof u.duration_ms === 'number' ? u.duration_ms : 0,
      };
    }
  }
  return out;
}

/**
 * Expand persisted ai_messages rows (ordered oldest-first) into the
 * sidebar's bubble sequence. User rows → one user bubble; assistant
 * rows → status pill (+ assistant line if there's text + meta line if
 * usage was recorded). System / tool_summary rows are skipped.
 */
export function rowsToTranscript(rows: ReadonlyArray<AiMessageRow>): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const row of rows) {
    if (row.role === 'user') {
      out.push({ id: `${row.id}-u`, kind: 'user', text: row.content ?? '' });
      continue;
    }
    if (row.role !== 'assistant') continue;

    const structured = readStructured(row);
    if (structured) {
      out.push({
        id: `${row.id}-s`,
        kind: 'status',
        label: structured.copilot.status_label,
        state: structured.copilot.status_state,
      });
    } else if (row.status === 'failed') {
      out.push({ id: `${row.id}-s`, kind: 'status', label: 'Error', state: 'error' });
    }

    const text = (row.content ?? '').trim();
    if (text.length > 0) {
      out.push({ id: `${row.id}-a`, kind: 'assistant', text: row.content ?? '' });
    }

    if (structured?.usage) {
      out.push({
        id: `${row.id}-m`,
        kind: 'meta',
        tokens: structured.usage.tokens,
        cost_approx: structured.usage.cost_approx,
        duration_ms: structured.usage.duration_ms,
      });
    }
  }
  return out;
}
