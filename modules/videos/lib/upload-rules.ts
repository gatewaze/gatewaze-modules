/**
 * What an editor may upload, decided without I/O so it can be tested.
 *
 * Every limit here is a real constraint from somewhere else in the stack, and
 * the comment says which, because a number with no provenance gets "tuned"
 * later by someone who does not know what it was protecting.
 */

/** Asset kinds an editor can deliver. */
export const UPLOAD_KINDS = ['master', 'short', 'caption', 'thumbnail'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/**
 * Accepted video mime types.
 *
 * Matches `event-media/lib/guest-limits.ts`'s VIDEO_MIME_ALLOWLIST rather than
 * host-media's `startsWith('video/')`, because an allowlist is the only form
 * of this check that is worth having: the stored Content-Type is attacker-
 * controlled on a signed PUT, and it is what the complete step enforces.
 */
export const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export const CAPTION_MIMES = ['text/vtt', 'application/x-subrip', 'text/plain'] as const;
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Per-kind byte ceilings.
 *
 * The master cap is 5 GiB because that is the `video-masters` bucket's own
 * file_size_limit (migration 007), and a cap above the bucket's would fail
 * late, after the whole upload, instead of at mint.
 */
export const MAX_BYTES: Record<UploadKind, number> = {
  master: 5 * 1024 * 1024 * 1024,
  // A short is a vertical clip under a minute. 500MB is generous for that and
  // small enough that a mistaken master upload lands here as an error rather
  // than silently consuming the master's budget.
  short: 500 * 1024 * 1024,
  caption: 5 * 1024 * 1024,
  thumbnail: 20 * 1024 * 1024,
};

export function allowedMimes(kind: UploadKind): readonly string[] {
  if (kind === 'master' || kind === 'short') return VIDEO_MIMES;
  if (kind === 'caption') return CAPTION_MIMES;
  return IMAGE_MIMES;
}

export type RejectReason =
  | 'unknown_kind'
  | 'mime_not_allowed'
  | 'too_large'
  | 'no_size'
  | 'bad_filename';

export interface UploadRequest {
  kind: string;
  mimeType: string;
  bytes: number;
  filename: string;
}

/**
 * `null` when the upload may proceed, otherwise why not.
 *
 * Size is required rather than optional: without it there is nothing to check
 * against the cap at mint, and discovering a 9GB file after it is uploaded is
 * too late to be useful.
 */
export function rejectUpload(req: UploadRequest): RejectReason | null {
  const kind = String(req.kind ?? '') as UploadKind;
  if (!(UPLOAD_KINDS as readonly string[]).includes(kind)) return 'unknown_kind';

  const mime = String(req.mimeType ?? '').toLowerCase().trim();
  if (!allowedMimes(kind).includes(mime)) return 'mime_not_allowed';

  const bytes = Number(req.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'no_size';
  if (bytes > MAX_BYTES[kind]) return 'too_large';

  const name = String(req.filename ?? '').trim();
  if (!name || name.length > 255) return 'bad_filename';

  return null;
}

/**
 * A filename safe to put in a storage path.
 *
 * A copy of host-media's sanitiser rather than an import, per the convention
 * its own siblings follow: a server-side cross-module import is resolved per
 * snapshot at deploy time and a missing sibling 404s the route path.
 *
 * Path traversal is the thing being stopped. The storage key is built from
 * this, so a filename of `../../other-bucket/x` must not escape its prefix.
 */
export function sanitiseFilename(name: string): string {
  const base = String(name ?? '')
    // Take the last path segment on either separator, so a full Windows or
    // POSIX path collapses to its filename.
    .split(/[\\/]/)
    .pop() ?? '';
  const cleaned = base
    .normalize('NFKD')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+/g, '-')
    // A run of dots inside a name ("a..b.mp4") would read as traversal to the
    // storage key check and fail the upload; one dot is what was meant.
    .replace(/\.{2,}/g, '.')
    .slice(0, 180);
  return cleaned || 'upload';
}

/**
 * The storage key for an asset.
 *
 * Shape mirrors host-media's `<hostKind>/<hostId>/<mediaId>/<filename>`: the
 * asset id in the path is what makes two editors uploading `talk.mp4` on the
 * same day land in different places, and what makes a stray object traceable
 * back to a row.
 */
export function buildStoragePath(args: {
  subjectType: string;
  subjectId: string;
  assetId: string;
  filename: string;
}): string {
  const subjectType = String(args.subjectType).replace(/[^a-z_]/g, '') || 'subject';
  return [
    subjectType,
    String(args.subjectId),
    String(args.assetId),
    sanitiseFilename(args.filename),
  ].join('/');
}

/** A thumbnail is the only asset kind that belongs in the public bucket. */
export function bucketFor(kind: UploadKind): string {
  return kind === 'thumbnail' ? 'media' : 'video-masters';
}
