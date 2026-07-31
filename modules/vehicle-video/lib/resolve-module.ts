/**
 * Locate sibling-module source files (the `ai` module) from inside the
 * vehicle-video module. The platform doesn't expose an in-process module-loader
 * API to module code, so (like daily-briefing / conference-recap) we reach into
 * sibling modules' runtime libs via dynamic import. Candidate paths cover dev
 * (workspace install + sibling-repo layout) and prod (the
 * `.gatewaze-modules/<slug>/modules/<id>/...` clone cache and the installed
 * snapshot under /var/lib/gatewaze).
 *
 * Directory depth: .../modules/vehicle-video/lib/resolve-module.ts
 *   resolve-module → lib → vehicle-video → modules → <slug> → cache root
 */

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function moduleCandidates(moduleId: string, subPath: string): string[] {
  const candidates: string[] = [
    `@gatewaze-modules/${moduleId}/${subPath}.js`,
    `../../../../gatewaze-modules/modules/${moduleId}/${subPath}.ts`,
  ];

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cacheRoot = resolve(here, '..', '..', '..', '..');
    if (existsSync(cacheRoot)) {
      for (const ent of readdirSync(cacheRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        for (const ext of ['ts', 'js']) {
          const candidate = resolve(cacheRoot, ent.name, 'modules', moduleId, `${subPath}.${ext}`);
          if (existsSync(candidate)) candidates.push(candidate);
        }
      }
    }
  } catch {
    // best-effort enumeration; static candidates above still try
  }

  candidates.push(`/var/lib/gatewaze/modules/${moduleId}/${subPath}.js`);
  return candidates;
}

export async function loadModuleSubpath<T = unknown>(
  moduleId: string,
  subPath: string,
  opts: { validate?: (mod: unknown) => mod is T; label?: string } = {},
): Promise<T> {
  const label = opts.label ?? `${moduleId}/${subPath}`;
  const candidates = moduleCandidates(moduleId, subPath);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (opts.validate && !opts.validate(mod)) continue;
      return mod as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `[vehicle-video] could not resolve ${label} from any candidate path` +
      (lastErr ? ` (last error: ${(lastErr as Error).message})` : ''),
  );
}
