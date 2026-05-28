/**
 * Compute the SHA-1 manifest Netlify expects.
 *
 * Netlify's deploy API uses SHA-1 for content addressing (legacy decision).
 * Our platform manifest uses SHA-256 — the source of truth for delta
 * computation. To avoid storing TWO digests per file, we re-hash here
 * when assembling the Netlify-side request body.
 *
 * Uses Web Crypto (`globalThis.crypto.subtle`) so the module bundles
 * cleanly into both Node (19+) and browser builds — Vite was stubbing
 * `node:crypto` and breaking the admin app's auto-registry import of
 * this module.
 */

export interface Sha1Entry {
  /** Without leading '/'. */
  relPath: string;
  bytes: Uint8Array | Buffer;
}

export interface Sha1Manifest {
  /** "/path" → "<sha1 hex>". */
  files: Record<string, string>;
  /** Raw entries with their hash, for the upload phase. */
  entries: ReadonlyArray<{ relPath: string; sha1: string; size: number }>;
}

export async function buildSha1Manifest(entries: ReadonlyArray<Sha1Entry>): Promise<Sha1Manifest> {
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  const seen = new Set<string>();
  const files: Record<string, string> = {};
  const out: Array<{ relPath: string; sha1: string; size: number }> = [];

  // Validate first (fail fast before doing any crypto work).
  for (const e of entries) {
    if (!e.relPath || typeof e.relPath !== 'string') throw new Error('entry missing relPath');
    if (e.relPath.startsWith('/') || e.relPath.startsWith('..')) {
      throw new Error(`entry.relPath must be relative (got ${e.relPath})`);
    }
    if (seen.has(e.relPath)) {
      throw new Error(`duplicate relPath in manifest: ${e.relPath}`);
    }
    seen.add(e.relPath);
  }

  for (const e of entries) {
    const view = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes);
    const sha1 = await sha1Hex(view);
    files['/' + e.relPath] = sha1;
    out.push({ relPath: e.relPath, sha1, size: view.byteLength });
  }
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, entries: out };
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto subtle.digest unavailable; need Node 19+ or a modern browser');
  }
  // SubtleCrypto.digest expects a BufferSource. Pass a fresh ArrayBuffer
  // view to avoid SharedArrayBuffer or detached-buffer surprises.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hashBuf = await subtle.digest('SHA-1', ab);
  const arr = new Uint8Array(hashBuf);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += (arr[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}
