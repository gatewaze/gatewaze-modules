#!/usr/bin/env node
// Drift-guard for per-module auth gates.
//
// Modules can't share a runtime require-jwt helper — the gatewaze-modules
// workspace isn't linked into the platform's node_modules, so each module that
// exposes an /api/modules/<id>/* route (which the platform does NOT auth-gate)
// ships its own lib/require-jwt.ts. Those copies have drifted before: a module
// once "verified" any non-HS256 (ES256 cloud) token by trusting the DECODED
// payload — an alg-confusion bypass (alg:none / algorithm substitution) — and
// another required an "upstream" userId that never exists for module routes
// (locking out cloud admins). This check makes that class of drift fail CI
// instead of shipping.
//
// Contract every module require-jwt.ts must satisfy:
//   1. If it branches on the token alg (dual-path HS256 vs cloud), the non-HS256
//      path MUST verify server-side via Supabase `auth.getUser` — never trust a
//      decoded payload, and never rely on an upstream gate.
//   2. If it uses `jwt.verify`, it MUST pin `algorithms:` (no alg confusion).

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulesDir = join(root, 'modules');

const failures = [];
let checked = 0;

for (const mod of existsSync(modulesDir) ? readdirSync(modulesDir) : []) {
  const p = join(modulesDir, mod, 'lib', 'require-jwt.ts');
  if (!existsSync(p)) continue;
  checked++;
  const src = readFileSync(p, 'utf8');
  const rel = `modules/${mod}/lib/require-jwt.ts`;

  // Only files that actually branch on the algorithm are dual-path auth gates.
  const isDualPath = /['"]HS256['"]/.test(src);
  if (isDualPath && !/getUser\s*\(/.test(src)) {
    failures.push(
      `${rel}: branches on HS256 but never calls auth.getUser — the non-HS256 ` +
      `(ES256 cloud) path must be verified server-side, not decoded-and-trusted ` +
      `or gated on a non-existent upstream userId.`,
    );
  }

  // jsonwebtoken path must pin the algorithm.
  if (/jwt\.verify\s*\(/.test(src) && !/algorithms\s*:/.test(src)) {
    failures.push(`${rel}: uses jwt.verify without pinning \`algorithms:\` — alg-confusion risk.`);
  }
}

if (failures.length) {
  console.error(`[check-module-require-jwt] ${failures.length} problem(s) across ${checked} module auth gate(s):\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('\nSee any of host-media / newsletters / vehicle-video / warehouse-sync lib/require-jwt.ts for the correct pattern.');
  process.exit(1);
}

console.log(`[check-module-require-jwt] OK — ${checked} module auth gate(s) verify non-HS256 tokens correctly.`);
