// @ts-nocheck — depends on @supabase/supabase-js which requires workspace install.

/**
 * Nightly cron — rebuilds host_media.used_in from scratch by walking
 * every registered consumer's content tables. Belt-and-braces against
 * trigger drift (missed updates, out-of-band data fixes, etc.).
 *
 * Per spec-host-media-module §4.4 + §12 (5-min runtime SLA at ~50k rows).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { HostMediaConsumer, HostMediaContentTable } from '@gatewaze/shared';
import { listHostMediaConsumers } from '../lib/registry.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

interface Deps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>;
  logger: PlatformLogger;
}

export async function rebuildUsedIn(deps: Deps): Promise<void> {
  const consumers = listHostMediaConsumers();
  if (consumers.length === 0) {
    deps.logger.warn('host-media used-in rebuild: no consumers registered');
    return;
  }
  deps.logger.info('host-media used-in rebuild: starting', { consumers: consumers.length });

  // Strategy: walk every (consumer, content-table) pair, collect
  // (media_id, type, id, name) tuples, then write back to host_media
  // via a server-side rebuild RPC. For Phase 1 we do the diff in JS;
  // a future v2 could push this into a single PL/pgSQL function for
  // throughput.
  const refsByMediaId = new Map<string, Array<{ type: string; id: string; name: string }>>();

  for (const consumer of consumers) {
    if (!consumer.contentTables || consumer.contentTables.length === 0) continue;
    for (const table of consumer.contentTables) {
      try {
        await collectFromTable(deps, consumer, table, refsByMediaId);
      } catch (err) {
        deps.logger.error('host-media used-in rebuild: table walk failed', {
          consumer: consumer.hostKind,
          table: table.table,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Single bulk update — set used_in for every row whose value changed.
  // For Phase 1, write naively (one UPDATE per media row). A later
  // optimisation could batch via UNNEST.
  let updated = 0;
  for (const [mediaId, refs] of refsByMediaId) {
    const { error } = await deps.supabase
      .from('host_media')
      .update({ used_in: refs })
      .eq('id', mediaId);
    if (!error) updated += 1;
  }

  // Clear used_in for media rows that no consumer referenced. Anything
  // not in refsByMediaId should have used_in = []. Bulk: select all
  // host_media rows, exclude the ones we just touched.
  const { data: orphaned } = await deps.supabase
    .from('host_media')
    .select('id')
    .neq('used_in', '[]');
  if (orphaned && Array.isArray(orphaned)) {
    for (const row of orphaned as Array<{ id: string }>) {
      if (!refsByMediaId.has(row.id)) {
        await deps.supabase.from('host_media').update({ used_in: [] }).eq('id', row.id);
      }
    }
  }

  deps.logger.info('host-media used-in rebuild: completed', {
    refsCollected: refsByMediaId.size,
    updated,
  });
}

async function collectFromTable(
  deps: Deps,
  consumer: HostMediaConsumer,
  table: HostMediaContentTable,
  refsByMediaId: Map<string, Array<{ type: string; id: string; name: string }>>,
): Promise<void> {
  const cols = [table.idColumn, table.contentColumn, table.nameColumn, table.hostIdColumn];
  if (!table.staticHostKind && table.hostKindColumn) cols.push(table.hostKindColumn);
  const colList = Array.from(new Set(cols)).join(', ');

  const { data, error } = await deps.supabase.from(table.table).select(colList);
  if (error) throw new Error(`select from ${table.table} failed: ${error.message}`);
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const hostKind = table.staticHostKind ?? (row[table.hostKindColumn ?? ''] as string);
    const hostId = row[table.hostIdColumn] as string;
    const consumerId = row[table.idColumn] as string;
    const consumerName = row[table.nameColumn] as string;
    const content = row[table.contentColumn];
    if (!hostKind || !hostId || !consumerId || hostKind !== consumer.hostKind) continue;

    const refs = await deps.supabase.rpc('host_media_extract_refs', { p_content: content });
    if (!refs.error && Array.isArray(refs.data)) {
      for (const r of refs.data as Array<{ media_id: string }>) {
        // Only record if the referenced media belongs to this same host.
        const { data: m } = await deps.supabase
          .from('host_media')
          .select('id, host_kind, host_id')
          .eq('id', r.media_id).maybeSingle();
        if (!m || m.host_kind !== hostKind || m.host_id !== hostId) continue;

        const existing = refsByMediaId.get(r.media_id) ?? [];
        if (!existing.some((e) => e.type === table.consumerType && e.id === consumerId)) {
          existing.push({ type: table.consumerType, id: consumerId, name: consumerName });
        }
        refsByMediaId.set(r.media_id, existing);
      }
    }
  }
}

/**
 * Job-runner entry point. Platform dispatches `data.kind = 'host-media:used-in-rebuild'`
 * here.
 */
export default async function handler(payload: { data?: { kind?: string } }, deps: Deps): Promise<void> {
  if (payload.data?.kind !== 'host-media:used-in-rebuild') return;
  await rebuildUsedIn(deps);
}
