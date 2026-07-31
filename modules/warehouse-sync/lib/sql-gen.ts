/**
 * SQL generator (§8.1) — derives, from the Appendix A manifest, the four
 * artifacts that MUST stay in lockstep:
 *
 *   1. generatePublicationSql   → the source publication (§10.1)
 *   2. generateReaderGrantsSql  → SELECT grants to the reader role (§10.2)
 *   3. generateStagingModelSql  → the STAGING MERGE transform per table (§7.2)
 *   4. generateMaskingPolicySql → Snowflake dynamic data masking (§8.2, §9.2)
 *
 * Pure string transforms over a validated Manifest — no fs, no external deps.
 * scripts/generate-sql.ts reads the YAML and writes the output to disk.
 *
 * RAW metadata columns (§7.1): the connector's RAW output carries change
 * metadata whose names + delete representation are connector-specific. They are
 * centralised here as `RawMeta`. The default targets **Airbyte** (Option B, the
 * chosen mechanism): Airbyte's Postgres CDC + Snowflake destination land a
 * `_ab_cdc_deleted_at` timestamp (non-null on a delete) and `_ab_cdc_updated_at`.
 * The generator also supports a boolean tombstone flag (e.g. Openflow) so the
 * mechanism stays swappable. STAGING (this contract) is the only stable surface
 * downstream.
 */
import type { ColumnSpec, Manifest, TableSpec } from './types.js';
import { directIdentifierColumns, sourceColumns } from './manifest.js';

export interface RawMeta {
  /** How RAW signals a delete: a non-null timestamp (Airbyte) or a boolean flag. */
  deleteKind: 'timestamp' | 'boolean';
  /** The delete-indicator column (Airbyte: _ab_cdc_deleted_at; boolean connectors: the flag). */
  deleteColumn: string;
  /** Timestamp the connector observed the change (Airbyte: _ab_cdc_updated_at). */
  changeTs: string;
}

/** Airbyte CDC → Snowflake destination metadata (the chosen mechanism, §5.1 Option B). */
export const AIRBYTE_RAW_META: RawMeta = {
  deleteKind: 'timestamp',
  deleteColumn: '_ab_cdc_deleted_at',
  changeTs: '_ab_cdc_updated_at',
};

/** Generic boolean-tombstone connector (e.g. Openflow), kept for swappability. */
export const BOOLEAN_FLAG_RAW_META: RawMeta = {
  deleteKind: 'boolean',
  deleteColumn: '_SNOWFLAKE_DELETED',
  changeTs: '_SNOWFLAKE_UPDATED_AT',
};

export const DEFAULT_RAW_META: RawMeta = AIRBYTE_RAW_META;

const GEN_HEADER = (m: Manifest, what: string): string =>
  `-- GENERATED from manifest/appendix-a.yaml (brand=${m.brand}, manifest v${m.version}) — DO NOT EDIT BY HAND.\n` +
  `-- ${what}\n` +
  `-- Regenerate: pnpm --filter @gatewaze-modules/warehouse-sync generate:sql\n`;

// ── 1. Publication (§10.1) ───────────────────────────────────────────────────

export function generatePublicationSql(m: Manifest, publication = 'snowflake_cdc'): string {
  const tables = m.tables.map((t) => `  ${m.source_schema}.${t.name}`).join(',\n');
  return (
    GEN_HEADER(m, `Explicit-table publication (§10.1) — scope governed at the source.`) +
    `\n-- Drop/recreate is destructive to the slot; ALTER PUBLICATION ADD/DROP TABLE for edits.\n` +
    `CREATE PUBLICATION ${publication} FOR TABLE\n${tables};\n`
  );
}

// ── 2. Reader grants (§10.2) ─────────────────────────────────────────────────

export function generateReaderGrantsSql(m: Manifest, role = 'snowflake_reader'): string {
  const grants = m.tables
    .map((t) => `GRANT SELECT ON ${m.source_schema}.${t.name} TO ${role};`)
    .join('\n');
  return (
    GEN_HEADER(m, `Per-table SELECT grants to the extraction role (§10.2).`) +
    `\n-- Grants do NOT auto-extend to tables later added to the publication (§8.1 four-step).\n` +
    `GRANT USAGE ON SCHEMA ${m.source_schema} TO ${role};\n${grants}\n`
  );
}

// ── 3. STAGING models (§7.2) ─────────────────────────────────────────────────

/** Snowflake column type for a manifest column (§7.2 typing rules). */
export function snowflakeType(c: ColumnSpec): string {
  if (c.derived === 'sha256_join') return 'STRING';
  switch (c.pg_type) {
    case 'uuid':
    case 'text':
      return 'STRING';
    case 'boolean':
      return 'BOOLEAN';
    case 'integer':
      return 'NUMBER(38,0)';
    case 'bigint':
      return 'NUMBER(38,0)';
    case 'numeric':
      return 'NUMBER(38,9)';
    case 'timestamptz':
    case 'timestamp':
      return 'TIMESTAMP_NTZ';
    case 'date':
      return 'DATE';
    case 'jsonb':
    case 'json':
      return 'VARIANT';
    case 'array':
      return 'ARRAY';
    default:
      return 'STRING';
  }
}

/** SELECT expression producing a STAGING column value from a RAW row. */
export function stagingSelectExpr(c: ColumnSpec): string {
  if (c.derived === 'sha256_join') {
    // Pinned normalisation + encoding (§8.2). Deterministic across datasets.
    return `LOWER(SHA2(LOWER(TRIM(src."${c.source_column}")), 256)) AS "${c.name}"`;
  }
  const src = `src."${c.name}"`;
  switch (c.pg_type) {
    case 'timestamptz':
    case 'timestamp':
      // Single repo-wide standard: convert to UTC, store timezone-naive (§7.2).
      return `CONVERT_TIMEZONE('UTC', ${src})::TIMESTAMP_NTZ AS "${c.name}"`;
    case 'uuid':
      return `${src}::STRING AS "${c.name}"`;
    default:
      return `${src} AS "${c.name}"`;
  }
}

/**
 * Full STAGING build for one table: an idempotent MERGE keyed by PK, adding the
 * contract columns (_synced_at, is_deleted, deleted_at) and applying the delete
 * semantics of §7.2.1. Explicit column list (never SELECT *) so additive RAW
 * columns don't break the model (§7.3).
 */
export function generateStagingModelSql(m: Manifest, t: TableSpec, raw: RawMeta = DEFAULT_RAW_META): string {
  const db = m.snowflake_database;
  const pk = t.primary_key;
  const src = sourceColumns(t);
  const derived = t.columns.filter((c) => c.derived);
  const idents = directIdentifierColumns(t);

  // is_deleted / deleted_at derivation (§7.2.1). `tombstonePredicate` is the
  // single boolean expression "this RAW row is a delete", reused for is_deleted,
  // deleted_at, and identifier-nulling so the three can never disagree.
  let isDeletedExpr: string;
  let deletedAtExpr: string;
  let tombstonePredicate: string; // hard-delete only
  if (t.delete.mode === 'soft') {
    const col = t.delete.column!;
    isDeletedExpr = `(src."${col}" IS NOT NULL)`;
    deletedAtExpr = `CONVERT_TIMEZONE('UTC', src."${col}")::TIMESTAMP_NTZ`;
    tombstonePredicate = isDeletedExpr;
  } else if (raw.deleteKind === 'timestamp') {
    // Airbyte: delete signalled by a non-null _ab_cdc_deleted_at, which IS the
    // delete-observed timestamp.
    tombstonePredicate = `(src."${raw.deleteColumn}" IS NOT NULL)`;
    isDeletedExpr = tombstonePredicate;
    deletedAtExpr = `CONVERT_TIMEZONE('UTC', src."${raw.deleteColumn}")::TIMESTAMP_NTZ`;
  } else {
    // Boolean-flag connector: delete signalled by a flag; deleted_at falls back
    // to the change timestamp (§7.2.1).
    tombstonePredicate = `COALESCE(src."${raw.deleteColumn}", FALSE)`;
    isDeletedExpr = tombstonePredicate;
    deletedAtExpr =
      `IFF(${tombstonePredicate}, CONVERT_TIMEZONE('UTC', src."${raw.changeTs}")::TIMESTAMP_NTZ, NULL)`;
  }

  // Value expressions. On a hard-delete tombstone, NULL direct/semi identifiers
  // AND any column derived from one (e.g. email_sha256) — otherwise an erased
  // person stays joinable by hash. This doubles as GDPR erasure (§7.2.1, §8.3).
  const identNames = new Set(idents.map((i) => i.name));
  const nullOnTombstone = (c: ColumnSpec): boolean =>
    identNames.has(c.name) || (!!c.source_column && identNames.has(c.source_column));

  const valueExprs: string[] = [];
  for (const c of [...src, ...derived]) {
    let expr = stagingSelectExpr(c);
    if (t.delete.mode === 'hard' && nullOnTombstone(c)) {
      // Wrap: value becomes NULL when the tombstone predicate holds.
      const alias = `"${c.name}"`;
      const inner = expr.replace(new RegExp(`\\s+AS\\s+${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
      expr = `IFF(${tombstonePredicate}, NULL, ${inner}) AS ${alias}`;
    }
    valueExprs.push(expr);
  }

  const allColNames = [...src, ...derived].map((c) => `"${c.name}"`);
  const contractCols = ['"_synced_at"', '"is_deleted"', '"deleted_at"'];
  const insertCols = [...allColNames, ...contractCols].join(', ');
  const insertVals = [
    ...[...src, ...derived].map((c) => `src2."${c.name}"`),
    'src2."_synced_at"',
    'src2."is_deleted"',
    'src2."deleted_at"',
  ].join(', ');
  const updateSet = [
    ...[...src, ...derived].map((c) => `tgt."${c.name}" = src2."${c.name}"`),
    'tgt."_synced_at" = src2."_synced_at"',
    'tgt."is_deleted" = src2."is_deleted"',
    'tgt."deleted_at" = src2."deleted_at"',
  ].join(',\n    ');

  const stagingSelect = [
    ...valueExprs,
    `CURRENT_TIMESTAMP()::TIMESTAMP_NTZ AS "_synced_at"`,
    `${isDeletedExpr} AS "is_deleted"`,
    `${deletedAtExpr} AS "deleted_at"`,
  ].join(',\n    ');

  // Change detection: only re-materialise rows whose source updated_at moved,
  // or whose delete state changed (§7.2).
  const changeGuard =
    t.delete.mode === 'soft'
      ? `WHEN MATCHED AND (src2."${t.updated_at}" > tgt."${t.updated_at}" OR src2."is_deleted" <> tgt."is_deleted") THEN`
      : `WHEN MATCHED AND (src2."${t.updated_at}" > tgt."${t.updated_at}" OR src2."is_deleted" <> tgt."is_deleted") THEN`;

  const cadence = t.large_fact ? '30 min (large fact, §6)' : '15 min (§6)';

  return (
    GEN_HEADER(m, `STAGING.${t.name} — current-state contract (§7.2). Refresh cadence: ${cadence}.`) +
    `\nMERGE INTO ${db}.STAGING.${t.name} AS tgt\n` +
    `USING (\n  SELECT\n    ${stagingSelect}\n  FROM ${db}.RAW.${t.name} AS src\n) AS src2\n` +
    `ON tgt."${pk}" = src2."${pk}"\n` +
    `${changeGuard}\n  UPDATE SET\n    ${updateSet}\n` +
    `WHEN NOT MATCHED THEN\n  INSERT (${insertCols})\n  VALUES (${insertVals});\n`
  );
}

/** CREATE TABLE for a STAGING target (run once; the MERGE above maintains it). */
export function generateStagingDdlSql(m: Manifest, t: TableSpec): string {
  const cols = t.columns
    .map((c) => {
      const nn = c.name === t.primary_key ? ' NOT NULL' : '';
      return `  "${c.name}" ${snowflakeType(c)}${nn}`;
    })
    .join(',\n');
  return (
    GEN_HEADER(m, `STAGING.${t.name} DDL (§7.2). Contract columns appended.`) +
    `\nCREATE TABLE IF NOT EXISTS ${m.snowflake_database}.STAGING.${t.name} (\n` +
    `${cols},\n` +
    `  "_synced_at" TIMESTAMP_NTZ NOT NULL,\n` +
    `  "is_deleted" BOOLEAN NOT NULL DEFAULT FALSE,\n` +
    `  "deleted_at" TIMESTAMP_NTZ,\n` +
    `  PRIMARY KEY ("${t.primary_key}")\n);\n`
  );
}

// ── 4. Masking policies (§8.2, §9.2) ─────────────────────────────────────────

/**
 * Dynamic data masking. One reusable policy per masking KIND, applied to each
 * column of that kind. Only AAIF_PII_BREAKGLASS_ROLE sees unmasked values;
 * AAIF_ANALYST_ROLE never does (§9.1).
 */
export function generateMaskingPolicySql(m: Manifest): string {
  const db = m.snowflake_database;
  const policies = `
CREATE MASKING POLICY IF NOT EXISTS ${db}.STAGING.mask_null AS (val STRING) RETURNS STRING ->
  CASE WHEN CURRENT_ROLE() IN ('AAIF_PII_BREAKGLASS_ROLE') THEN val ELSE NULL END;

CREATE MASKING POLICY IF NOT EXISTS ${db}.STAGING.mask_full AS (val STRING) RETURNS STRING ->
  CASE WHEN CURRENT_ROLE() IN ('AAIF_PII_BREAKGLASS_ROLE') THEN val ELSE '***MASKED***' END;

CREATE MASKING POLICY IF NOT EXISTS ${db}.STAGING.mask_email_domain AS (val STRING) RETURNS STRING ->
  CASE WHEN CURRENT_ROLE() IN ('AAIF_PII_BREAKGLASS_ROLE') THEN val
       WHEN val IS NULL THEN NULL
       ELSE '***@' || SPLIT_PART(val, '@', 2) END;
`.trimStart();

  const policyFor: Record<string, string | null> = {
    none: null,
    sha256_join: null,
    null: 'mask_null',
    full: 'mask_full',
    domain_only: 'mask_email_domain',
  };

  const applies: string[] = [];
  for (const t of m.tables) {
    for (const c of t.columns) {
      const policy = policyFor[c.masking];
      if (!policy) continue;
      applies.push(
        `ALTER TABLE ${db}.STAGING.${t.name} MODIFY COLUMN "${c.name}" ` +
          `SET MASKING POLICY ${db}.STAGING.${policy};`,
      );
    }
  }

  return (
    GEN_HEADER(m, `Dynamic data masking policies + column bindings (§8.2, §9.2). PII-1 only.`) +
    `\n${policies}\n${applies.join('\n')}\n`
  );
}
