/**
 * Storage-path helpers. Paths are UUID-prefixed to prevent filename
 * collisions and avoid CDN cache poisoning when re-uploading.
 *
 * Per spec-host-media-module §3.4.
 */

const FILENAME_MAX = 200;

/**
 * Strip path-traversal characters and clip to FILENAME_MAX bytes per
 * spec §3.4 ("filename with `..`, `/`, NUL stripped"). Spaces and
 * other normally-safe characters are preserved — Supabase Storage
 * URL-encodes them at the edge.
 */
export function sanitiseFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const NUL = /\x00/g;
  const PATH_SEP = /[/\\]/g;
  const PARENT = /\.\./g;
  return filename
    .replace(NUL, '')
    .replace(PATH_SEP, '_')
    .replace(PARENT, '_')
    .slice(0, FILENAME_MAX)
    .trim();
}

export function buildStoragePath(
  hostKind: string,
  hostId: string,
  mediaId: string,
  filename: string,
): string {
  return `${hostKind}/${hostId}/${mediaId}/${sanitiseFilename(filename)}`;
}

/**
 * Storage path for a chunked upload's individual chunks. Each chunk
 * lives at <basePath>/__chunked/<uploadId>/<index> until the combine
 * step reassembles them into the final media path.
 */
export function buildChunkStoragePath(
  hostKind: string,
  hostId: string,
  uploadId: string,
  chunkIndex: number,
): string {
  return `${hostKind}/${hostId}/__chunked/${uploadId}/${chunkIndex}`;
}
