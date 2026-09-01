/**
 * Sync planner — pure translation from the operator's per-table config
 * (warehouse_sync_table_config) into per-frequency-tier Airbyte connection
 * plans. Airbyte schedules are per-connection, so each active frequency tier
 * becomes one connection carrying the tables assigned to it, each stream with
 * its own sync mode.
 *
 * No I/O — the API handler calls this, then applies the plans via AirbyteClient.
 */

export type Frequency = 'realtime' | 'hourly' | 'daily';
export type SyncMode = 'incremental' | 'full_refresh';

export interface TableConfig {
  table_name: string;
  namespace: string;
  enabled: boolean;
  sync_mode: SyncMode;
  frequency: Frequency;
  cursor_field?: string | null;
  primary_key?: string | null;
  use_cdc?: boolean;
}

/** Airbyte public-API stream sync-mode strings. */
export type AirbyteStreamSyncMode =
  | 'full_refresh_overwrite'
  | 'full_refresh_append'
  | 'incremental_append'
  | 'incremental_deduped_history';

export interface StreamPlan {
  name: string;
  syncMode: AirbyteStreamSyncMode;
  cursorField?: string[];
  primaryKey?: string[][];
}

export interface TierPlan {
  frequency: Frequency;
  streams: StreamPlan[];
}

/** Map one table's config to its Airbyte stream sync mode + keys. */
export function streamForTable(t: TableConfig): StreamPlan {
  if (t.sync_mode === 'full_refresh') {
    return { name: t.table_name, syncMode: 'full_refresh_overwrite' };
  }
  // incremental
  const pk = t.primary_key ? [[t.primary_key]] : undefined;
  // CDC provides ordering; a cursor is still supplied when present. With a PK we
  // dedupe (current-state); without a PK we append.
  if (pk) {
    return {
      name: t.table_name,
      syncMode: 'incremental_deduped_history',
      ...(t.cursor_field ? { cursorField: [t.cursor_field] } : {}),
      primaryKey: pk,
    };
  }
  if (t.cursor_field) {
    return { name: t.table_name, syncMode: 'incremental_append', cursorField: [t.cursor_field] };
  }
  // No PK and no cursor and not CDC → can't do incremental; fall back to full.
  return { name: t.table_name, syncMode: 'full_refresh_overwrite' };
}

/**
 * Group enabled tables into per-frequency tier plans. Tiers with no enabled
 * tables are returned with an empty stream list so the caller can pause/clear
 * that tier's connection.
 */
export function planTiers(configs: TableConfig[]): TierPlan[] {
  const byFreq: Record<Frequency, StreamPlan[]> = { realtime: [], hourly: [], daily: [] };
  for (const t of configs) {
    if (!t.enabled) continue;
    byFreq[t.frequency].push(streamForTable(t));
  }
  return (['realtime', 'hourly', 'daily'] as Frequency[]).map((frequency) => ({
    frequency,
    streams: byFreq[frequency],
  }));
}

/** Does any enabled table in a tier use log-based CDC? (source must be CDC then.) */
export function tierNeedsCdc(configs: TableConfig[], frequency: Frequency): boolean {
  return configs.some((t) => t.enabled && t.frequency === frequency && t.sync_mode === 'incremental' && !!t.use_cdc);
}
