/**
 * Locate @gatewaze-modules/ai source files from the resources module.
 *
 * The platform doesn't expose an in-process module-loader API to
 * module-side code, so we reach into the ai module's sources via dynamic
 * import. Resolution chain (dev-friendly first, then the production
 * layouts):
 *   1. `@gatewaze-modules/ai/<path>.js` — workspace install (works in dev).
 *   2. `../../ai/<path>.ts` — sibling module in the same modules/ dir
 *      (resources + ai both live under gatewaze-modules/modules).
 *   3. Every `<slug>/modules/ai/<path>.{ts,js}` under the `.gatewaze-modules`
 *      cache dir — the production clone layout.
 *   4. `/var/lib/gatewaze/modules/ai/<path>.js` — installed snapshot the
 *      api lays down for enabled modules.
 *
 * The cache root is computed from this file's own `import.meta.url` so it
 * stays correct regardless of the on-disk layout. Mirrors the equivalent
 * helper in the daily-briefing and lunch-and-learn modules.
 */

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function aiModuleCandidates(subPath: string): string[] {
  const candidates: string[] = [
    `@gatewaze-modules/ai/${subPath}.js`,
    `../../ai/${subPath}.ts`,
  ];

  // Walk up to the .gatewaze-modules cache dir from this file:
  //   file:///app/.gatewaze-modules/<slug>/modules/resources/lib/resolve-ai-module.ts
  //   resolve-ai-module.ts → lib → resources → modules → <slug> → .gatewaze-modules
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cacheRoot = resolve(here, '..', '..', '..', '..');
    if (existsSync(cacheRoot)) {
      for (const ent of readdirSync(cacheRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        for (const ext of ['ts', 'js']) {
          const candidate = resolve(cacheRoot, ent.name, 'modules', 'ai', `${subPath}.${ext}`);
          if (existsSync(candidate)) candidates.push(candidate);
        }
      }
    }
  } catch {
    // best-effort enumeration; static candidates above still try
  }

  candidates.push(`/var/lib/gatewaze/modules/ai/${subPath}.js`);
  return candidates;
}

/**
 * Resolve and dynamic-import an ai-module sub-path. Tries every candidate;
 * throws the last error if none resolve.
 */
export async function loadAiModuleSubpath<T = unknown>(
  subPath: string,
  opts: { validate?: (mod: unknown) => mod is T; label?: string } = {},
): Promise<T> {
  const label = opts.label ?? subPath;
  const candidates = aiModuleCandidates(subPath);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (opts.validate && !opts.validate(mod)) {
        lastErr = new Error(`module shape did not match validator (${candidate})`);
        continue;
      }
      return mod as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `resources: failed to resolve @gatewaze-modules/ai/${label}. ` +
      `Tried ${candidates.length} candidate(s). Last error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
  );
}
