/**
 * Upload batches: the pure parts. The prefix a batch owns, the connection
 * bundle an editor is handed, and how a filename becomes a title.
 */

export const BATCHES_ROOT = 'batches/';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function batchPrefix(batchId: string): string {
  if (!UUID_RE.test(batchId)) throw new Error('bad batch id');
  return `${BATCHES_ROOT}${batchId.toLowerCase()}/`;
}

export const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

/** Smaller than this is not a talk recording; larger than this the studio will not take. */
export const MIN_BATCH_FILE_BYTES = 1024 * 1024;
export const MAX_BATCH_FILE_BYTES = 8 * 1024 * 1024 * 1024;
export const DEFAULT_BATCH_MAX_FILES = 200;

/**
 * Does the start of the file look like the container its name claims? An
 * ISO media file (mp4, m4v, mov) has `ftyp` at byte 4; WebM starts with the
 * EBML magic. A file named .mp4 that is neither is not handed to ffmpeg.
 */
export function looksLikeVideo(head: Buffer, mime: string): boolean {
  if (head.length < 12) return false;
  if (mime === 'video/webm') return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  return head.subarray(4, 8).toString('latin1') === 'ftyp';
}

/** A file name safe to put in a log line: no control characters, bounded. */
export function logName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return String(name ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '?').slice(0, 120);
}

/** A talk title from a file name: no extension, separators to spaces, a leading number dropped. */
export function titleFromFilename(name: string): string {
  return String(name ?? '')
    .split('/').pop()!
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/^\s*\d{1,3}\s*[-._ ]+\s*/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export interface BundleInput {
  bucket: string;
  prefix: string;
  keyId: string;
  key: string;
  endpoint: string;
  region: string;
  label: string;
}

export interface ConnectionBundle {
  /** Opens Cyberduck connected to the folder (its Backblaze B2 profile). */
  cyberduck_url: string;
  /** The same through the S3 profile, for clients without a B2 profile. */
  s3_url: string;
  /** A Cyberduck bookmark file; the key is asked for once on connect. */
  duck_bookmark: string;
  rclone_conf: string;
  rclone_command: string;
  /** Plain fields, for a client that wants them typed in. */
  fields: { endpoint: string; region: string; bucket: string; folder: string; key_id: string; key: string };
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Everything an editor needs to connect, built once from the minted key.
 * The key appears here and nowhere else; the API returns it in the create
 * response and never stores it.
 */
export function connectionBundle(i: BundleInput): ConnectionBundle {
  const host = new URL(i.endpoint).hostname;
  const folder = i.prefix.replace(/\/$/, '');
  const enc = encodeURIComponent;
  const remote = 'gatewaze';
  return {
    cyberduck_url: `b2://${enc(i.keyId)}:${enc(i.key)}@api.backblazeb2.com/${i.bucket}/${folder}/`,
    s3_url: `s3://${enc(i.keyId)}:${enc(i.key)}@${host}/${i.bucket}/${folder}/`,
    duck_bookmark: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Protocol</key><string>b2</string>
  <key>Nickname</key><string>${xml(i.label)}</string>
  <key>Hostname</key><string>api.backblazeb2.com</string>
  <key>Username</key><string>${xml(i.keyId)}</string>
  <key>Path</key><string>/${xml(i.bucket)}/${xml(folder)}</string>
</dict>
</plist>
`,
    rclone_conf: `[${remote}]\ntype = b2\naccount = ${i.keyId}\nkey = ${i.key}\n`,
    rclone_command: `rclone copy ./ ${remote}:${i.bucket}/${folder}/ --transfers 8 --b2-upload-concurrency 4 --progress`,
    fields: { endpoint: i.endpoint, region: i.region, bucket: i.bucket, folder: `${folder}/`, key_id: i.keyId, key: i.key },
  };
}
