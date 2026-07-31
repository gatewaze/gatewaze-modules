// @ts-nocheck — dev/CI script; runs under tsx with `yaml` (devDependency).
/**
 * Generate the four §8.1 lockstep artifacts from manifest/appendix-a.yaml, so
 * the publication, grants, STAGING models and masking policies can never drift
 * from the governance manifest.
 *
 *   pnpm --filter @gatewaze-modules/warehouse-sync generate:sql
 *
 * Outputs (git-tracked; review the diff on every manifest change):
 *   snowflake/staging/generated/publication.sql
 *   snowflake/staging/generated/reader_grants.sql
 *   snowflake/staging/generated/masking_policies.sql
 *   snowflake/staging/generated/<table>.sql       (DDL + MERGE per table)
 *   lib/reconcile-targets.ts                        (reconcile worker input)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validateManifest } from '../lib/manifest.js';
import {
  generatePublicationSql,
  generateReaderGrantsSql,
  generateMaskingPolicySql,
  generateStagingDdlSql,
  generateStagingModelSql,
} from '../lib/sql-gen.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'snowflake', 'staging', 'generated');

function write(rel, contents) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`  wrote ${rel}`);
}

const raw = readFileSync(join(root, 'manifest', 'appendix-a.yaml'), 'utf8');
const manifest = validateManifest(parse(raw));
console.log(`manifest ok: brand=${manifest.brand} tables=${manifest.tables.length}`);

mkdirSync(outDir, { recursive: true });
write('snowflake/staging/generated/publication.sql', generatePublicationSql(manifest));
write('snowflake/staging/generated/reader_grants.sql', generateReaderGrantsSql(manifest));
write('snowflake/staging/generated/masking_policies.sql', generateMaskingPolicySql(manifest));

for (const t of manifest.tables) {
  const body = `${generateStagingDdlSql(manifest, t)}\n${generateStagingModelSql(manifest, t)}`;
  write(`snowflake/staging/generated/${t.name}.sql`, body);
}

// Regenerate the reconcile-worker target list from the manifest.
const targets = manifest.tables.map((t) => ({
  schema: manifest.source_schema,
  table: t.name,
  deletedCol: t.delete.mode === 'soft' ? t.delete.column : null,
  updatedCol: t.updated_at ?? null,
}));
const tsLines = targets
  .map(
    (t) =>
      `  { schema: '${t.schema}', table: '${t.table}', deletedCol: ${
        t.deletedCol ? `'${t.deletedCol}'` : 'null'
      }, updatedCol: ${t.updatedCol ? `'${t.updatedCol}'` : 'null'} },`,
  )
  .join('\n');
write(
  'lib/reconcile-targets.ts',
  `/**\n * Reconciliation targets (§12.3) — GENERATED from manifest/appendix-a.yaml.\n * Edit the manifest, then \`pnpm generate:sql\`.\n */\nexport interface ReconcileTarget {\n  schema: string;\n  table: string;\n  deletedCol: string | null;\n  updatedCol: string | null;\n}\n\nexport const RECONCILE_TARGETS: ReconcileTarget[] = [\n${tsLines}\n];\n`,
);

console.log('done.');
