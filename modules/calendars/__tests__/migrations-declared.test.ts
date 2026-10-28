/**
 * Guard: migrations/*.sql on disk and index.ts's `migrations: [...]` must agree, both ways.
 * The platform runner applies only the declared array, so an undeclared file is never run,
 * and a declared file that is missing makes the runner throw mid-run. Same guard as
 * modules/software-engineer/__tests__/migrations-declared.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import calendarsModule from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const onDisk = readdirSync(resolve(here, '..', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => `migrations/${f}`)
  .sort();
const declared = calendarsModule.migrations ?? [];

describe('calendars migrations are declared', () => {
  it('has a non-empty declaration', () => {
    expect(onDisk.length).toBeGreaterThan(0);
    expect(declared.length).toBeGreaterThan(0);
  });

  it('declares every migrations/*.sql on disk', () => {
    expect(onDisk.filter((f) => !declared.includes(f))).toEqual([]);
  });

  it('declares no file that is missing from disk', () => {
    expect(declared.filter((f) => !onDisk.includes(f))).toEqual([]);
  });

  it('declares each file exactly once', () => {
    expect(new Set(declared).size).toBe(declared.length);
  });
});
