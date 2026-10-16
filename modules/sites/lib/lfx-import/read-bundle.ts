/**
 * Reads an extracted lfx-mos-website bundle from disk into an LfxBundle.
 *
 * The zip extracts to a single top-level folder (e.g.
 * `jupyter-foundation-website/`); pass either that folder or its parent.
 *
 * The archive is untrusted: every file is read only if it is a regular
 * file (no symlinks, so a crafted zip cannot point `site.css` at
 * `~/.ssh/id_rsa`), resolves under the bundle root, and stays under a
 * size cap.
 */

import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { LfxBundle, LfxSiteJson } from './types.js';

export const LFX_BUNDLE_LIMITS = {
  siteJsonBytes: 2 * 1024 * 1024,
  cssBytes: 512 * 1024,
  jsBytes: 128 * 1024,
  svgBytes: 512 * 1024,
} as const;

async function regularFileUnder(root: string, path: string, maxBytes: number): Promise<string | undefined> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return undefined;
  }
  if (!st.isFile()) throw new Error(`lfx-import: ${path} is not a regular file (symlinks are not allowed in a bundle)`);
  if (st.size > maxBytes) throw new Error(`lfx-import: ${path} is ${st.size} bytes; limit is ${maxBytes}`);
  const real = await realpath(path);
  const realRoot = await realpath(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(`lfx-import: ${path} resolves outside the bundle root`);
  }
  return readFile(real, 'utf8');
}

/** Locate the folder that holds site.json (the given dir or one level down). */
export async function findBundleRoot(dir: string): Promise<string> {
  const direct = await lstat(join(dir, 'site.json')).catch(() => null);
  if (direct) return dir;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const nested = await lstat(join(dir, e.name, 'site.json')).catch(() => null);
    if (nested) return join(dir, e.name);
  }
  throw new Error(`lfx-import: no site.json found in ${dir} (or one level below)`);
}

export async function readLfxBundle(dir: string): Promise<LfxBundle> {
  const root = await findBundleRoot(dir);
  const raw = await regularFileUnder(root, join(root, 'site.json'), LFX_BUNDLE_LIMITS.siteJsonBytes);
  if (!raw) throw new Error(`lfx-import: site.json missing in ${root}`);
  const site = JSON.parse(raw) as LfxSiteJson;
  if (typeof site !== 'object' || site === null || !site.project || !site.pages) {
    throw new Error('lfx-import: site.json does not look like an lfx-mos-website bundle');
  }
  const css = await regularFileUnder(root, join(root, 'assets', 'site.css'), LFX_BUNDLE_LIMITS.cssBytes);
  if (!css) throw new Error(`lfx-import: assets/site.css missing in ${root}`);
  const svg = (name: string) => regularFileUnder(root, join(root, 'assets', name), LFX_BUNDLE_LIMITS.svgBytes);
  return {
    site,
    css,
    js: await regularFileUnder(root, join(root, 'assets', 'site.js'), LFX_BUNDLE_LIMITS.jsBytes),
    logos: {
      light: await svg('logo.svg'),
      reversed: await svg('logo-reversed.svg'),
      favicon: await svg('favicon.svg'),
    },
  };
}
