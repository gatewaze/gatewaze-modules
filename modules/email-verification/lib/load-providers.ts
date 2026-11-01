/**
 * Find the provider modules that are enabled and load each one's provider.ts.
 *
 * A provider is any enabled module whose id starts with
 * `email-verification-`. It is looked for beside this module first (the same
 * repository), then in the worker's module roots, so a provider can live in
 * another module repository.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROVIDER_PREFIX, providerId } from './config';
import type { VerificationProvider } from './types';

const MODULE_ROOTS = ['/var/lib/gatewaze/modules', '/gatewaze-modules/modules', '/lf-gatewaze-modules/modules'];

function thisModuleDir(): string {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return path.resolve(__dirname, '..');
  }
}

export interface InstalledProvider {
  id: string;
  config: Record<string, unknown>;
}

export interface LoadedProvider extends InstalledProvider {
  provider: VerificationProvider;
}

function isProvider(v: unknown): v is VerificationProvider {
  const p = v as VerificationProvider | null;
  return !!p && typeof p.verify === 'function' && typeof p.isConfigured === 'function' && typeof p.label === 'string';
}

export function providerPaths(id: string, coreDir: string = thisModuleDir()): string[] {
  const parent = path.dirname(coreDir);
  return [path.join(parent, id), ...MODULE_ROOTS.map((r) => path.join(r, id))].flatMap((dir) => [
    path.join(dir, 'provider.ts'),
    path.join(dir, 'provider.js'),
  ]);
}

/** Load each installed provider. One that cannot be found or loaded is logged and left out. */
export async function loadProviders(installed: InstalledProvider[]): Promise<LoadedProvider[]> {
  const out: LoadedProvider[] = [];
  for (const row of installed) {
    // The id comes from installed_modules; accept only a well-formed provider
    // id so it cannot point the import outside the module roots.
    if (providerId(row.id) !== row.id || !row.id.startsWith(PROVIDER_PREFIX)) continue;
    const file = providerPaths(row.id).find((p) => existsSync(p));
    if (!file) {
      console.warn(`[email-verification] provider ${row.id} is enabled but its provider.ts was not found`);
      continue;
    }
    try {
      const mod = await import(pathToFileURL(file).href);
      const provider = mod?.default ?? mod?.provider;
      if (!isProvider(provider)) {
        console.warn(`[email-verification] ${file} does not export a provider`);
        continue;
      }
      out.push({ ...row, provider });
    } catch (e) {
      console.warn(`[email-verification] could not load provider ${row.id}: ${(e as Error).message}`);
    }
  }
  return out;
}
