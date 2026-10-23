// The module runner applies only the files named in index.ts `migrations`,
// in that order. A .sql file left out of the array is never applied, and an
// entry with no file aborts the module's remaining migrations. Same guard as
// software-engineer/__tests__/migrations-declared.test.ts.
//
// Run: node --experimental-strip-types --test __tests__/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import blogModule from '../index.ts';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const onDisk = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => `migrations/${f}`);
const declared = blogModule.migrations ?? [];

test('declares a non-empty list', () => {
  assert.ok(onDisk.length > 0 && declared.length > 0);
});

test('every declared migration exists on disk', () => {
  assert.deepEqual(declared.filter((f) => !onDisk.includes(f)), []);
});

test('every migration on disk is declared', () => {
  assert.deepEqual(onDisk.filter((f) => !declared.includes(f)), []);
});

test('011 and 012 are declared, after 010, in order', () => {
  const i10 = declared.indexOf('migrations/010_status_check_triage_states.sql');
  const i11 = declared.indexOf('migrations/011_register_adapters_retry.sql');
  const i12 = declared.indexOf('migrations/012_triage_sets_publish_state.sql');
  assert.ok(i10 >= 0 && i11 > i10 && i12 > i11, `order: 010@${i10} 011@${i11} 012@${i12}`);
});
