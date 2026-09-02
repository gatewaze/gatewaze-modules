#!/usr/bin/env node
/**
 * Bump a module's version in its index.ts.
 *
 *   node scripts/bump-module-version.mjs <module> [patch|minor|major]
 *   node scripts/bump-module-version.mjs <module> --set 2.0.0
 *   node scripts/bump-module-version.mjs --changed [patch|minor|major]
 *
 * The platform reads this field to decide whether an update is available and
 * to check minPlatformVersion compatibility, so it needs to reflect reality.
 * The CI check only asks that the version moved; which part moves is your
 * call. Patch for a fix, minor for new behaviour, major for a breaking change.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VERSION_RE = /(version:\s*['"`])(\d+)\.(\d+)\.(\d+)(['"`])/;

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('usage: node scripts/bump-module-version.mjs <module> [patch|minor|major]');
  console.error('       node scripts/bump-module-version.mjs <module> --set <x.y.z>');
  console.error('       node scripts/bump-module-version.mjs --changed [patch|minor|major]');
  process.exit(msg ? 1 : 0);
}

function bump(version, level) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Modules with changes against origin/main, for --changed. */
function changedModules() {
  let base = 'origin/main';
  try {
    execFileSync('git', ['rev-parse', '--verify', base], { stdio: 'pipe' });
  } catch {
    base = 'main';
  }
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  const mods = new Set();
  for (const line of out.split('\n')) {
    const m = /^modules\/([^/]+)\//.exec(line.trim());
    if (!m) continue;
    // Same exemptions as the CI check.
    if (/\/(guide\.md|README\.md)$/.test(line)) continue;
    if (/\.test\.[tj]s$/.test(line) || line.includes('/__tests__/')) continue;
    mods.add(m[1]);
  }
  return [...mods].sort();
}

function applyTo(moduleName, level, explicit) {
  const index = resolve('modules', moduleName, 'index.ts');
  if (!existsSync(index)) {
    console.error(`  ${moduleName}: no modules/${moduleName}/index.ts`);
    return false;
  }

  const src = readFileSync(index, 'utf8');
  const match = VERSION_RE.exec(src);
  if (!match) {
    console.error(`  ${moduleName}: no semver version field found`);
    return false;
  }

  const current = `${match[2]}.${match[3]}.${match[4]}`;
  const next = explicit ?? bump(current, level);

  writeFileSync(index, src.replace(VERSION_RE, `$1${next}$5`), 'utf8');
  console.log(`  ${moduleName}: ${current} -> ${next}`);
  return true;
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') usage();

let explicit;
const setIdx = args.indexOf('--set');
if (setIdx !== -1) {
  explicit = args[setIdx + 1];
  if (!explicit || !/^\d+\.\d+\.\d+$/.test(explicit)) usage('--set needs an x.y.z version');
  args.splice(setIdx, 2);
}

const target = args[0];
const level = args[1] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(level)) usage(`unknown level "${level}"`);

const targets = target === '--changed' ? changedModules() : [target];

if (targets.length === 0) {
  console.log('No changed modules found.');
  process.exit(0);
}
if (target === '--changed' && explicit) usage('--set takes a single module, not --changed');

let failed = 0;
for (const m of targets) {
  if (!applyTo(m, level, explicit)) failed++;
}
process.exit(failed > 0 ? 1 : 0);
