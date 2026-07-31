/**
 * Types for the Appendix A manifest (§8.1, §17) — the single source of truth
 * from which the SQL generator derives the publication, grants, STAGING
 * transforms and masking policies. Mirrors manifest/appendix-a.yaml.
 */

export type Classification = 'none' | 'direct' | 'semi' | 'quasi';

/** Masking applied in STAGING under PII-1 (§8.2). */
export type Masking =
  | 'none'
  | 'null'
  | 'domain_only'
  | 'full'
  | 'sha256_join';

/** Postgres source type we know how to normalise into a Snowflake type (§7.2). */
export type PgType =
  | 'uuid'
  | 'text'
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'timestamptz'
  | 'timestamp'
  | 'date'
  | 'jsonb'
  | 'json'
  | 'array';

export interface ColumnSpec {
  name: string;
  /** Present for source columns; absent for derived columns. */
  pg_type?: PgType;
  /** Present for generated columns (e.g. `sha256_join` from `source_column`). */
  derived?: Masking;
  source_column?: string;
  classification: Classification;
  masking: Masking;
  /** True when this column is a stable, non-PII join key (§8.2, §11). */
  join_key?: boolean;
}

export type DeleteMode = 'soft' | 'hard';

export interface DeleteSpec {
  mode: DeleteMode;
  /** Required when mode === 'soft': the source soft-delete column (§7.2.1). */
  column?: string;
}

export interface TableSpec {
  name: string;
  primary_key: string;
  /** Change-detection column for the idempotent STAGING MERGE (§7.2). */
  updated_at: string;
  delete: DeleteSpec;
  /** Large mutable fact → incremental MERGE, 30-min cadence (§6). */
  large_fact?: boolean;
  columns: ColumnSpec[];
}

export interface Conventions {
  timestamp: string;
  uuid: string;
  jsonb: string;
  array: string;
  join_key_normalisation: string;
  join_key_encoding: string;
  canonical_join_key: string;
}

export interface RetentionSpec {
  raw_change_history_days: number;
  tombstone_days: number;
  operations_log_days: number;
}

export interface Manifest {
  version: number;
  brand: string;
  snowflake_database: string;
  source_schema: string;
  conventions: Conventions;
  retention: RetentionSpec;
  tables: TableSpec[];
}
