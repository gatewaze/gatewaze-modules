/**
 * Guard: migrations/*.sql on disk and index.ts's `migrations: [...]` must agree, both ways.
 *
 * WHY THIS EXISTS
 * The platform runner does NOT glob the migrations directory. applyModuleMigrations()
 * (packages/shared/src/modules/migrations.ts) iterates the module's declared `migrations`
 * array and nothing else, so a .sql file that the array does not name is invisible to it:
 * it is never applied, on staging or on a fresh database, and nothing reports that.
 *
 * On 2026-08-23 four SE files had drifted out of the array — 018_runs_created_at_cost_idx,
 * 025_env_events, 026_env_events_paging_retention and 027_clarity_insights. All four had to
 * be applied to the staging database by hand, twice for some of them, and a fresh database
 * would have run the env-log and Clarity routes against tables that did not exist. The only
 * reason anyone noticed is that the staging updater started reporting undeclared files.
 *
 * The reverse direction matters just as much: an entry naming a file that does not exist
 * makes the runner throw mid-run, which aborts that module's remaining migrations.
 *
 * Scope is deliberately this module only. A repo-wide version would be useful (a survey on
 * 2026-08-23 found 20 undeclared files across 12 other modules) but is not safe to bolt on
 * blindly — some of those undeclared files are older than migrations their module has already
 * applied, so "declare everything" would reorder history for them. Fixing those is each
 * module owner's call.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import softwareEngineerModule from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');

const onDisk = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => `migrations/${f}`)
  .sort();

const declared = softwareEngineerModule.migrations ?? [];

describe('software-engineer migrations are declared', () => {
  it('has a non-empty declaration (a bad import would make every other assertion vacuous)', () => {
    expect(onDisk.length).toBeGreaterThan(0);
    expect(declared.length).toBeGreaterThan(0);
  });

  it('declares every migrations/*.sql on disk', () => {
    const undeclared = onDisk.filter((f) => !declared.includes(f));
    expect(
      undeclared,
      `${undeclared.length} migration file(s) exist on disk but are missing from the ` +
        `migrations[] array in modules/software-engineer/index.ts. The platform runner reads ` +
        `only that array, so these would NEVER be applied — not on staging, not on a fresh ` +
        `database. Add them to the array in the position they should run.`,
    ).toEqual([]);
  });

  it('declares no file that is missing from disk', () => {
    const missing = declared.filter((f) => !onDisk.includes(f));
    expect(
      missing,
      `${missing.length} entr(y/ies) in the migrations[] array name a file that does not ` +
        `exist under modules/software-engineer/migrations/. The runner throws when it cannot ` +
        `read a declared file, which aborts the rest of this module's migrations. Restore the ` +
        `file or drop the entry.`,
    ).toEqual([]);
  });

  it('declares each file exactly once', () => {
    const seen = new Set<string>();
    const dupes = declared.filter((f) => (seen.has(f) ? true : (seen.add(f), false)));
    expect(dupes, `duplicate migrations[] entr(y/ies): ${dupes.join(', ')}`).toEqual([]);
  });

  it('uses the migrations/ prefix on every entry', () => {
    // module_migrations.filename stores these verbatim, so the prefix is part of the
    // identity of an applied migration. A bare '025_env_events.sql' would read as a
    // different, unapplied migration and be re-run.
    const unprefixed = declared.filter((f) => !f.startsWith('migrations/'));
    expect(
      unprefixed,
      `migrations[] entr(y/ies) without the 'migrations/' prefix: ${unprefixed.join(', ')}. ` +
        `The recorded filename in module_migrations is this string verbatim, so changing the ` +
        `prefix makes an applied migration look unapplied and re-runs it.`,
    ).toEqual([]);
  });
});
