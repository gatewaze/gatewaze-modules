/**
 * Sync planner — pure translation from the operator's per-table config
 * (warehouse_sync_table_config) into per-frequency-tier Airbyte connection
 * plans. Airbyte schedules are per-connection, so each active frequency tier
 * becomes one connection carrying the tables assigned to it, each stream with
 * its own sync mode.
 *
 * Catalog-driven: the discovered Airbyte catalog (source-defined cursor / primary
 * key / available fields) validates and repairs each stream so we never send an
 * invalid cursor (e.g. hardcoding `updated_at` for a table that lacks it — the
 * bug that 400'd the whole tier). With a log-based CDC source, incremental streams
 * carry NO user cursor: the connector orders by the WAL LSN (`_ab_cdc_lsn`).
 *
 * No I/O — the API handler discovers the catalog, calls this, then applies the
 * plans via AirbyteClient.
 */

import { isPiiField } from './pii.js';

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
  /** false = redact PII columns for this stream (test destinations); true = full row. */
  include_pii?: boolean;
}

/** One discovered source stream (from AirbyteClient.discoverCatalog). */
export interface CatalogStream {
  name: string;
  fields: string[];
  defaultCursorField?: string[];
  sourceDefinedPrimaryKey?: string[][];
  syncModes?: string[];
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
  /** Present only when PII is redacted — the non-PII column subset. */
  selectedFields?: { fieldPath: string[] }[];
}

export interface TierPlan {
  frequency: Frequency;
  streams: StreamPlan[];
}

export interface SkippedTable {
  table_name: string;
  reason: string;
}

/**
 * Map one table's config to its Airbyte stream, validated against the discovered
 * catalog. Returns null when the table cannot be synced (absent from the source
 * catalog — e.g. a view, or a table not in the CDC publication); the caller
 * records the reason.
 */
export function streamForTable(t: TableConfig, catalog?: CatalogStream): StreamPlan | null {
  if (!catalog) return null; // not in the source catalog → cannot sync

  const pk: string[][] | undefined = t.primary_key
    ? [[t.primary_key]]
    : catalog.sourceDefinedPrimaryKey && catalog.sourceDefinedPrimaryKey.length
      ? catalog.sourceDefinedPrimaryKey
      : undefined;

  let plan: StreamPlan;

  if (t.sync_mode === 'full_refresh') {
    plan = { name: t.table_name, syncMode: 'full_refresh_overwrite' };
  } else if (t.use_cdc) {
    // Log-based CDC: the connector orders by _ab_cdc_lsn — do NOT send a user
    // cursor. Dedupe by PK when we have one; otherwise append.
    plan = pk
      ? { name: t.table_name, syncMode: 'incremental_deduped_history', primaryKey: pk }
      : { name: t.table_name, syncMode: 'incremental_append' };
  } else {
    // Cursor-based incremental: the cursor MUST be a real column. Prefer the
    // configured cursor when valid, else the source-defined default, else fall
    // back to a full refresh rather than send an invalid cursor.
    const cursor = pickCursor(t.cursor_field, catalog);
    if (cursor && pk) {
      plan = { name: t.table_name, syncMode: 'incremental_deduped_history', cursorField: [cursor], primaryKey: pk };
    } else if (cursor) {
      plan = { name: t.table_name, syncMode: 'incremental_append', cursorField: [cursor] };
    } else {
      plan = { name: t.table_name, syncMode: 'full_refresh_overwrite' };
    }
  }

  // Column-level PII redaction (§8.2): restrict to non-PII fields, always keeping
  // CDC metadata + primary key + cursor (Airbyte rejects the stream otherwise).
  if (t.include_pii === false && catalog.fields && catalog.fields.length) {
    const keep = new Set<string>();
    (plan.primaryKey ?? []).forEach((k) => k.forEach((c) => keep.add(c)));
    (plan.cursorField ?? []).forEach((c) => keep.add(c));
    const selected = catalog.fields.filter(
      (f) => f.toLowerCase().startsWith('_ab_cdc') || keep.has(f) || !isPiiField(f),
    );
    // Only apply a subset when it actually drops something; an all-fields list is
    // equivalent to no selection but riskier to get exactly right.
    if (selected.length < catalog.fields.length) {
      plan.selectedFields = selected.map((f) => ({ fieldPath: [f] }));
    }
  }

  return plan;
}

/** Choose a valid cursor column: configured (if it exists) → source default → none. */
function pickCursor(configured: string | null | undefined, catalog: CatalogStream): string | null {
  if (configured && catalog.fields.includes(configured)) return configured;
  const def = catalog.defaultCursorField?.[0];
  // The source default under CDC is _ab_cdc_lsn; that is only valid for CDC mode,
  // handled separately — don't use it for plain cursor incremental.
  if (def && !def.toLowerCase().startsWith('_ab_cdc') && catalog.fields.includes(def)) return def;
  return null;
}

/**
 * Group enabled tables into per-frequency tier plans, validated against the
 * discovered catalog. Tables absent from the catalog are collected in `skipped`
 * (with a reason) instead of aborting the tier. Tiers with no valid streams are
 * returned empty so the caller can pause/clear that tier's connection.
 */
export function planTiers(
  configs: TableConfig[],
  catalogByName: Map<string, CatalogStream> = new Map(),
): { tiers: TierPlan[]; skipped: SkippedTable[] } {
  const byFreq: Record<Frequency, StreamPlan[]> = { realtime: [], hourly: [], daily: [] };
  const skipped: SkippedTable[] = [];

  for (const t of configs) {
    if (!t.enabled) continue;
    const catalog = catalogByName.get(t.table_name);
    const plan = streamForTable(t, catalog);
    if (!plan) {
      skipped.push({
        table_name: t.table_name,
        reason: catalogByName.size
          ? 'not in the source catalog (a view, or not in the CDC publication)'
          : 'catalog unavailable',
      });
      continue;
    }
    byFreq[t.frequency].push(plan);
  }

  const tiers = (['realtime', 'hourly', 'daily'] as Frequency[]).map((frequency) => ({
    frequency,
    streams: byFreq[frequency],
  }));
  return { tiers, skipped };
}

/** Does any enabled table in a tier use log-based CDC? (source must be CDC then.) */
export function tierNeedsCdc(configs: TableConfig[], frequency: Frequency): boolean {
  return configs.some(
    (t) => t.enabled && t.frequency === frequency && t.sync_mode === 'incremental' && !!t.use_cdc,
  );
}
