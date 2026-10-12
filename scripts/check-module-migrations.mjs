#!/usr/bin/env node
/**
 * Two checks on the migrations a pull request ADDS.
 *
 * Both exist because both failures happened, repeatedly, and both are silent.
 *
 * 1. DECLARED. Each module's index.ts lists its migrations in a `migrations`
 *    array and the platform reads that list. There is no directory fallback,
 *    so a .sql file that is not in the array never runs. The file looks
 *    present, the feature looks shipped, and the first query against the table
 *    it was supposed to create fails. health-diet shipped exactly that with
 *    010_exercise_credit.sql: staging stayed on 009 and nothing complained.
 *
 * 2. NO REUSED NUMBER. Two branches cut from the same main both take the next
 *    free number, and whichever merges second collides. That happened four
 *    times in a week, in health-core and twice in software-engineer. The
 *    merge conflict only appears if both touch the index.ts list, and when it
 *    does not, two files share a number and the order they apply in is
 *    whatever sorts first.
 *
 * Scoped to ADDED files on purpose. Some modules have older migrations missing
 * from their array, applied out of band, and re-declaring those could re-run
 * something that is not idempotent. That is a decision for whoever applied
 * them, not for a gate on a new pull request.
 *
 * Usage: check-module-migrations.mjs <baseSha> <headSha>
 */

import { execFileSync } from 'node:child_process';

const [baseSha, headSha] = process.argv.slice(2);
if (!baseSha || !headSha) {
  console.error('usage: check-module-migrations.mjs <baseSha> <headSha>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

/** Files this pull request adds, under some module's migrations directory. */
function addedMigrations() {
  const out = git('diff', '--name-only', '--diff-filter=A', baseSha, headSha);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^modules\/[^/]+\/migrations\/.+\.sql$/.test(l));
}

/**
 * The migration filenames a module's index.ts declares.
 *
 * Returns null when the file has no `migrations` array at all, which is
 * different from declaring an empty one: the first is a module that may be
 * handled some other way, the second is a module that says it has none.
 */
function declaredIn(indexPath) {
  // Read at headSha rather than off disk. In CI the checkout is already the
  // head commit so both agree, but reading the commit makes the check correct
  // whatever the working tree happens to be, and testable against history.
  let src;
  try {
    src = git('show', `${headSha}:${indexPath}`);
  } catch {
    return null;
  }
  const block = /migrations:\s*\[([\s\S]*?)\]/.exec(src);
  if (!block) return null;
  return new Set(
    [...block[1].matchAll(/['"]migrations\/([^'"]+\.sql)['"]/g)].map((m) => m[1]),
  );
}

/** Migration filenames that already exist on the base branch for a module. */
function onBase(moduleId) {
  try {
    const out = git('ls-tree', '--name-only', baseSha, `modules/${moduleId}/migrations/`);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.sql'))
      .map((l) => l.split('/').pop());
  } catch {
    // No migrations directory on the base branch: nothing to collide with.
    return [];
  }
}

/** The leading number, which is what orders a migration and what collides. */
const numberOf = (filename) => (/^(\d+)/.exec(filename) ?? [])[1] ?? null;

const added = addedMigrations();
if (added.length === 0) {
  console.log('No migrations added.');
  process.exit(0);
}

const undeclared = [];
const collisions = [];
const skipped = [];

for (const path of added) {
  const moduleId = path.split('/')[1];
  const filename = path.split('/').pop();
  const indexPath = `modules/${moduleId}/index.ts`;

  const declared = declaredIn(indexPath);
  if (declared === null) {
    skipped.push({ moduleId, filename });
  } else if (!declared.has(filename)) {
    undeclared.push({ moduleId, filename, indexPath });
  }

  const num = numberOf(filename);
  if (num) {
    const clash = onBase(moduleId).filter(
      (f) => f !== filename && numberOf(f) === num,
    );
    if (clash.length) collisions.push({ moduleId, filename, clash });
  }

  const status = [];
  if (declared !== null && declared.has(filename)) status.push('declared');
  console.log(`  ${moduleId}/${filename}${status.length ? ` (${status.join(', ')})` : ''}`);
}

let failed = false;

if (undeclared.length) {
  failed = true;
  console.log('');
  console.log('These migrations are not declared in their module index.ts, so the');
  console.log('platform will never run them:');
  for (const u of undeclared) {
    console.log(`  - ${u.moduleId}/${u.filename}`);
    console.log(`      add 'migrations/${u.filename}' to the migrations array in ${u.indexPath}`);
  }
}

if (collisions.length) {
  failed = true;
  console.log('');
  console.log('These migrations reuse a number that already exists on the base branch.');
  console.log('Renumber them to follow the highest on the base branch:');
  for (const c of collisions) {
    console.log(`  - ${c.moduleId}/${c.filename} collides with ${c.clash.join(', ')}`);
  }
}

if (skipped.length) {
  console.log('');
  console.log('Not checked for declaration, because these modules have no migrations');
  console.log('array in index.ts:');
  for (const s of skipped) console.log(`  - ${s.moduleId}/${s.filename}`);
}

if (failed) process.exit(1);

console.log('');
console.log('Every added migration is declared and takes a free number.');
