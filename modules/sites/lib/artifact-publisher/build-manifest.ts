/**
 * Build a BuildArtifact's `fileManifest` from a list of (relPath, bytes)
 * pairs. The manifest pairs each file with its SHA-256 hex digest so the
 * publisher can compute deltas against its previous deployment.
 *
 * Per IExternalPublisher (types/index.ts), the manifest entries must:
 *   - have `relPath` relative to artifactDir
 *   - have a `sha256` hex digest of the bytes
 *   - have a `size` byte count
 *
 * This helper hashes a sequence of buffers; the caller is responsible for
 * gathering the bytes (typically from the renderer's HTML output + media
 * sync results).
 */

import { createHash } from 'node:crypto';

export interface ManifestEntryInput {
  relPath: string;
  bytes: Uint8Array | Buffer;
}

export interface ManifestEntry {
  relPath: string;
  sha256: string;
  size: number;
}

export function buildFileManifest(entries: ReadonlyArray<ManifestEntryInput>): ManifestEntry[] {
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  const seen = new Set<string>();
  const out: ManifestEntry[] = [];
  for (const e of entries) {
    if (!e.relPath || typeof e.relPath !== 'string') throw new Error('entry missing relPath');
    if (e.relPath.startsWith('/') || e.relPath.startsWith('..')) {
      throw new Error(`entry.relPath must be relative (got ${e.relPath})`);
    }
    if (seen.has(e.relPath)) {
      throw new Error(`duplicate relPath in manifest: ${e.relPath}`);
    }
    seen.add(e.relPath);
    const bytes = e.bytes instanceof Buffer ? e.bytes : Buffer.from(e.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    out.push({ relPath: e.relPath, sha256, size: bytes.length });
  }
  // Stable ordering — publishers compare manifests by relPath.
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

/**
 * Produce a manifest delta — the set of relPaths whose sha256 changed (or
 * which were added) vs a baseline. The publisher uses this to skip
 * unchanged file uploads.
 */
export function manifestDelta(
  baseline: ReadonlyArray<ManifestEntry>,
  next: ReadonlyArray<ManifestEntry>,
): { changed: ManifestEntry[]; removed: string[] } {
  const baseByPath = new Map<string, ManifestEntry>();
  for (const e of baseline) baseByPath.set(e.relPath, e);

  const changed: ManifestEntry[] = [];
  for (const e of next) {
    const prev = baseByPath.get(e.relPath);
    if (!prev || prev.sha256 !== e.sha256) {
      changed.push(e);
    }
    baseByPath.delete(e.relPath);
  }
  // Anything left in baseByPath is removed.
  const removed = Array.from(baseByPath.keys()).sort();
  return { changed, removed };
}
