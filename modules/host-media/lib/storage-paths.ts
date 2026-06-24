/**
 * Storage-path helpers. Paths are UUID-prefixed to prevent filename
 * collisions and avoid CDN cache poisoning when re-uploading.
 *
 * Per spec-host-media-module §3.4.
 */

const FILENAME_MAX = 200;

/**
 * Produce a URL-safe filename for storage + display.
 *
 * Background: filenames flow straight into `<img src>` / `<a href>` in
 * sent emails. Browsers happily auto-encode unsafe characters in a URL,
 * but mail clients (Gmail in particular) refuse to load images whose
 * src contains literal spaces or other unsafe bytes. So we slugify at
 * the upload boundary: the storage path, the cdn_url, and the display
 * filename in the DB are all guaranteed URL-safe.
 *
 * Transform:
 *   1. Split off the final extension.
 *   2. Lowercase the base.
 *   3. Collapse any run of non-`[a-z0-9]` chars to `-`.
 *   4. Trim leading/trailing `-`.
 *   5. If empty (e.g. all unsafe chars), fall back to `file`.
 *   6. Re-attach the lowercased extension.
 *   7. Clip to FILENAME_MAX.
 *
 * Examples:
 *   "The RePPIT framework.png" -> "the-reppit-framework.png"
 *   "../../etc/passwd"         -> "etc-passwd"
 *   "photo-2026-05-07.JPG"     -> "photo-2026-05-07.jpg"
 *
 * Collisions inside the bucket are not a concern: storage paths embed
 * the row's UUID (`<hostKind>/<hostId>/<mediaId>/<filename>`), so two
 * uploads of the same filename land at distinct paths.
 */
export function sanitiseFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = filename.replace(/\x00/g, '').trim();

  // Extract a "real" extension: the final alnum run after the last `.`, but
  // only when there's no path-separator AFTER the dot (otherwise the "ext"
  // is actually a path segment) and the ext is plausibly an extension (no
  // separator inside, no other dots). For inputs like "../../../etc/passwd"
  // this leaves the whole string in the base, which is what we want.
  const extMatch = stripped.match(/^(.*?)\.([A-Za-z0-9]+)$/);
  const rawBase = extMatch ? extMatch[1]! : stripped;
  const rawExt = extMatch ? extMatch[2]! : '';

  const slugBase =
    rawBase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'file';

  const slugExt = rawExt.toLowerCase();

  const out = slugExt ? `${slugBase}.${slugExt}` : slugBase;
  return out.slice(0, FILENAME_MAX);
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
