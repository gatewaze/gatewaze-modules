import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  ManifestError,
  inScopeSourceTables,
  joinKeyColumns,
} from '../lib/manifest';
import {
  generatePublicationSql,
  generateReaderGrantsSql,
  generateStagingModelSql,
  generateMaskingPolicySql,
  snowflakeType,
} from '../lib/sql-gen';
import type { Manifest } from '../lib/types';

const base: Manifest = {
  version: 1,
  brand: 'aaif',
  snowflake_database: 'AAIF',
  source_schema: 'public',
  conventions: {
    timestamp: 'TIMESTAMP_NTZ',
    uuid: 'STRING',
    jsonb: 'VARIANT',
    array: 'ARRAY',
    join_key_normalisation: 'LOWER(TRIM(email))',
    join_key_encoding: 'sha2-256 hex',
    canonical_join_key: 'people.id',
  },
  retention: { raw_change_history_days: 180, tombstone_days: 90, operations_log_days: 30 },
  tables: [
    {
      name: 'people',
      primary_key: 'id',
      updated_at: 'updated_at',
      delete: { mode: 'soft', column: 'deleted_at' },
      columns: [
        { name: 'id', pg_type: 'uuid', classification: 'none', masking: 'none', join_key: true },
        { name: 'email', pg_type: 'text', classification: 'direct', masking: 'domain_only' },
        { name: 'email_sha256', derived: 'sha256_join', source_column: 'email', classification: 'none', masking: 'none', join_key: true },
        { name: 'full_name', pg_type: 'text', classification: 'direct', masking: 'null' },
        { name: 'created_at', pg_type: 'timestamptz', classification: 'none', masking: 'none' },
        { name: 'updated_at', pg_type: 'timestamptz', classification: 'none', masking: 'none' },
        { name: 'deleted_at', pg_type: 'timestamptz', classification: 'none', masking: 'none' },
      ],
    },
    {
      name: 'send_log',
      primary_key: 'id',
      updated_at: 'updated_at',
      delete: { mode: 'hard' },
      large_fact: true,
      columns: [
        { name: 'id', pg_type: 'uuid', classification: 'none', masking: 'none' },
        { name: 'email', pg_type: 'text', classification: 'direct', masking: 'domain_only' },
        { name: 'updated_at', pg_type: 'timestamptz', classification: 'none', masking: 'none' },
      ],
    },
  ],
};

describe('manifest validation', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => validateManifest(base)).not.toThrow();
  });

  it('rejects a direct identifier with masking:none (§8.2)', () => {
    const bad = structuredClone(base);
    bad.tables[0].columns[1].masking = 'none';
    expect(() => validateManifest(bad)).toThrow(ManifestError);
  });

  it('rejects a soft delete without a column (§7.2.1)', () => {
    const bad = structuredClone(base);
    delete bad.tables[0].delete.column;
    expect(() => validateManifest(bad)).toThrow(ManifestError);
  });

  it('exposes fully-qualified source tables and join keys', () => {
    expect(inScopeSourceTables(base)).toContain('public.people');
    expect(joinKeyColumns(base.tables[0]).map((c) => c.name)).toEqual(['id', 'email_sha256']);
  });
});

describe('sql generation', () => {
  it('publication lists every in-scope table', () => {
    const sql = generatePublicationSql(base);
    expect(sql).toContain('public.people');
    expect(sql).toContain('public.send_log');
    expect(sql).toContain('CREATE PUBLICATION snowflake_cdc');
  });

  it('grants SELECT per table', () => {
    const sql = generateReaderGrantsSql(base);
    expect(sql).toContain('GRANT SELECT ON public.people TO snowflake_reader;');
  });

  it('maps postgres types to Snowflake types (§7.2)', () => {
    expect(snowflakeType(base.tables[0].columns[0])).toBe('STRING'); // uuid
    expect(snowflakeType(base.tables[0].columns[4])).toBe('TIMESTAMP_NTZ'); // timestamptz
  });

  it('soft-delete STAGING derives is_deleted + UTC timestamps + sha256 join key', () => {
    const sql = generateStagingModelSql(base, base.tables[0]);
    expect(sql).toContain("CONVERT_TIMEZONE('UTC'");
    expect(sql).toContain('LOWER(SHA2(LOWER(TRIM(src."email")), 256))');
    expect(sql).toContain('(src."deleted_at" IS NOT NULL) AS "is_deleted"');
  });

  it('hard-delete STAGING (Airbyte) nulls identifiers on the tombstone (§7.2.1/§8.3)', () => {
    const sql = generateStagingModelSql(base, base.tables[1]);
    // Airbyte: delete signalled by a non-null _ab_cdc_deleted_at
    expect(sql).toContain('(src."_ab_cdc_deleted_at" IS NOT NULL) AS "is_deleted"');
    // email is a direct identifier → nulled when the row is a delete
    expect(sql).toContain('IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."email") AS "email"');
    // the derived hash must ALSO be nulled, else an erased person stays joinable
    expect(sql).toContain(
      'IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, LOWER(SHA2(LOWER(TRIM(src."email")), 256))) AS "email_sha256"',
    );
  });

  it('boolean-flag connector remains expressible (swappability)', () => {
    const { BOOLEAN_FLAG_RAW_META } = require('../lib/sql-gen');
    const sql = generateStagingModelSql(base, base.tables[1], BOOLEAN_FLAG_RAW_META);
    expect(sql).toContain('COALESCE(src."_SNOWFLAKE_DELETED", FALSE) AS "is_deleted"');
  });

  it('masking policies bind email to the domain policy (§9.2)', () => {
    const sql = generateMaskingPolicySql(base);
    expect(sql).toContain('mask_email_domain');
    expect(sql).toContain('MODIFY COLUMN "email" SET MASKING POLICY AAIF.STAGING.mask_email_domain');
    expect(sql).toContain('MODIFY COLUMN "full_name" SET MASKING POLICY AAIF.STAGING.mask_null');
  });
});
