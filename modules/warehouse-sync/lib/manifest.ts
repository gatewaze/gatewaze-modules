/**
 * Manifest validation + accessors (§8.1). Pure — operates on an already-parsed
 * object (the caller does the fs + YAML read), so this file stays free of
 * runtime deps and fully typecheckable in isolation.
 *
 * Validation is deliberately strict: the manifest is a production gate, so a
 * malformed entry must fail loudly at generate time, not silently drop a table
 * from the publication or a mask from a PII column.
 */
import type {
  ColumnSpec,
  Manifest,
  Masking,
  TableSpec,
} from './types.js';

export class ManifestError extends Error {}

const MASKINGS: readonly Masking[] = ['none', 'null', 'domain_only', 'full', 'sha256_join'];
const CLASSIFICATIONS = ['none', 'direct', 'semi', 'quasi'] as const;

function req<T>(v: T | undefined | null, where: string): T {
  if (v === undefined || v === null) throw new ManifestError(`missing required field: ${where}`);
  return v;
}

function validateColumn(table: string, c: ColumnSpec): void {
  const where = `tables[${table}].columns[${c?.name ?? '?'}]`;
  req(c.name, `${where}.name`);
  if (!c.derived) req(c.pg_type, `${where}.pg_type (non-derived column needs a source type)`);
  if (c.derived === 'sha256_join') {
    req(c.source_column, `${where}.source_column (sha256_join needs a source)`);
  }
  if (!CLASSIFICATIONS.includes(c.classification)) {
    throw new ManifestError(`${where}.classification invalid: ${c.classification}`);
  }
  if (!MASKINGS.includes(c.masking)) {
    throw new ManifestError(`${where}.masking invalid: ${c.masking}`);
  }
  // Governance invariant (§8.2): a direct identifier MUST carry a real mask
  // under PII-1. sha256_join columns are non-PII derivations, exempt.
  if (c.classification === 'direct' && c.masking === 'none') {
    throw new ManifestError(
      `${where}: direct-identifier column exposed with masking:none — set null/domain_only/full or exclude it (§8.2)`,
    );
  }
}

function validateTable(t: TableSpec): void {
  const where = `tables[${t?.name ?? '?'}]`;
  req(t.name, `${where}.name`);
  req(t.primary_key, `${where}.primary_key`);
  req(t.updated_at, `${where}.updated_at`);
  const del = req(t.delete, `${where}.delete`);
  if (del.mode === 'soft' && !del.column) {
    throw new ManifestError(`${where}.delete: mode 'soft' requires a 'column' (§7.2.1)`);
  }
  if (!Array.isArray(t.columns) || t.columns.length === 0) {
    throw new ManifestError(`${where}.columns must be a non-empty list`);
  }
  const pkCol = t.columns.find((c) => c.name === t.primary_key);
  if (!pkCol) throw new ManifestError(`${where}.primary_key '${t.primary_key}' not present in columns`);
  for (const c of t.columns) validateColumn(t.name, c);
}

/** Validate a parsed manifest object and return it strongly typed. */
export function validateManifest(obj: unknown): Manifest {
  const m = obj as Manifest;
  req(m, 'manifest root');
  req(m.brand, 'brand');
  req(m.snowflake_database, 'snowflake_database');
  req(m.source_schema, 'source_schema');
  req(m.conventions, 'conventions');
  req(m.retention, 'retention');
  if (!Array.isArray(m.tables) || m.tables.length === 0) {
    throw new ManifestError('manifest.tables must be a non-empty list');
  }
  const names = new Set<string>();
  for (const t of m.tables) {
    if (names.has(t.name)) throw new ManifestError(`duplicate table in manifest: ${t.name}`);
    names.add(t.name);
    validateTable(t);
  }
  return m;
}

// ── Accessors used by the generator and tests ───────────────────────────────

/** Fully-qualified in-scope source tables, e.g. `public.people` (§10.1). */
export function inScopeSourceTables(m: Manifest): string[] {
  return m.tables.map((t) => `${m.source_schema}.${t.name}`);
}

/** Source columns only (derived columns don't exist in Postgres). */
export function sourceColumns(t: TableSpec): ColumnSpec[] {
  return t.columns.filter((c) => !c.derived);
}

/** Columns marked as deterministic join keys (§8.2, §11). */
export function joinKeyColumns(t: TableSpec): ColumnSpec[] {
  return t.columns.filter((c) => c.join_key);
}

/** Columns that carry a masking policy other than none (§9.2). */
export function maskedColumns(t: TableSpec): ColumnSpec[] {
  return t.columns.filter((c) => c.masking !== 'none');
}

/** Direct + semi PII columns whose identifiers must be nulled in tombstones (§7.2.1, §8.3). */
export function directIdentifierColumns(t: TableSpec): ColumnSpec[] {
  return t.columns.filter((c) => c.classification === 'direct' || c.classification === 'semi');
}
