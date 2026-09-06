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
//   3. The exported middleware MUST NOT be able to throw. Express 4 does not
//      catch rejections from async middleware, so a throw out of the SOLE auth
//      gate becomes an unhandledRejection — which the platform api's Sentry hook
//      turns into process.exit(1). That made an unauthenticated `alg: HS256`
//      request a remote kill-switch for the whole api on any ES256-only
//      (Supabase cloud) deployment, where `getJwtSecret()` throws. Every gate
//      needs a catch-all so an auth bug degrades to "denied", not to a dead
//      process.
//   4. A `GATEWAZE_TEST_DISABLE_AUTH` bypass MUST also be guarded on
//      `NODE_ENV !== 'production'`, so one stray env var cannot turn off
//      authentication on a real deployment.

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulesDir = join(root, 'modules');

const failures = [];
let checked = 0;

/** Every module source file, minus deps and test files. */
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      yield* sourceFiles(p);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) {
      yield p;
    }
  }
}

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

  // The exported middleware must have a catch-all, so nothing can throw out of
  // the gate. Two accepted shapes: an inner `gate` awaited inside try/catch, or
  // the returned middleware body opening directly with `try {`.
  const wrapsInnerGate = /await\s+gate\s*\([\s\S]{0,200}?\}\s*catch/.test(src);
  // Tolerant of the exact signature/annotation: any middleware body opening with `try {`.
  const opensWithTry = /=>\s*\{\s*try\s*\{/.test(src) || /\)\s*\{\s*try\s*\{/.test(src);
  if (!wrapsInnerGate && !opensWithTry) {
    failures.push(
      `${rel}: the exported middleware has no catch-all. Express 4 does not catch ` +
      `async-middleware rejections, so a throw here becomes an unhandledRejection ` +
      `and the api exits. Wrap the gate: \`try { await gate(req, res, next) } catch { ...401 }\`.`,
    );
  }

}

// Rule 4 applies repo-wide, not just to require-jwt.ts: a test-only auth bypass
// is just as dangerous in a hand-rolled admin gate (modules/software-engineer's
// admin router had one that skipped the whole admin-role check). Checked
// per-LINE so a guarded bypass elsewhere in the file can't vouch for an
// unguarded one — and so a `NODE_ENV` check for some unrelated purpose can't
// either. Test files are excluded: they set the var deliberately.
let bypassSites = 0;
for (const file of existsSync(modulesDir) ? sourceFiles(modulesDir) : []) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.includes('GATEWAZE_TEST_DISABLE_AUTH')) return;
    bypassSites++;
    if (!/NODE_ENV\s*!==\s*['"]production['"]/.test(line)) {
      failures.push(
        `${relative(root, file)}:${i + 1}: GATEWAZE_TEST_DISABLE_AUTH bypass is not guarded on ` +
        `\`NODE_ENV !== 'production'\` on the same expression — a stray env var would disable auth ` +
        `on a real deployment.`,
      );
    }
  });
}

if (failures.length) {
  console.error(`[check-module-require-jwt] ${failures.length} problem(s) across ${checked} module auth gate(s):\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('\nSee any of host-media / newsletters / vehicle-video / warehouse-sync lib/require-jwt.ts for the correct pattern.');
  process.exit(1);
}

console.log(
  `[check-module-require-jwt] OK — ${checked} module auth gate(s) verify non-HS256 tokens ` +
  `correctly and cannot throw; ${bypassSites} test-bypass site(s) are production-guarded.`,
);
