/**
 * Guest-upload validation: mime/size allowlists, input cleaning,
 * short-code generation + validation, and rate-limit keys.
 *
 * Per spec-event-media-guest-uploads §5 + §9.
 */

import { randomUUID, getRandomValues } from 'node:crypto';

// ── Mime allowlists ─────────────────────────────────────────────────

export const PHOTO_MIME_ALLOWLIST = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
] as const;

export const VIDEO_MIME_ALLOWLIST = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const;

export type MediaKind = 'photo' | 'video';

export function classifyMime(mimeType: string, allowVideo: boolean): MediaKind | null {
  if ((PHOTO_MIME_ALLOWLIST as readonly string[]).includes(mimeType)) return 'photo';
  if (allowVideo && (VIDEO_MIME_ALLOWLIST as readonly string[]).includes(mimeType)) return 'video';
  return null;
}

// ── Input cleaning ──────────────────────────────────────────────────

export const GUEST_NAME_MAX = 80;

/** Trim, strip control chars, clip. Returns null when nothing usable
 *  remains (callers decide whether a name is required). */
export function cleanGuestName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, GUEST_NAME_MAX);
  return cleaned.length > 0 ? cleaned : null;
}

// ── Short codes ─────────────────────────────────────────────────────

// 10 base36 chars ≈ 3.7e15 keyspace (invites' 6 chars ≈ 2.2e9 was the
// known weakness this feature deliberately does not copy).
export const SHORT_CODE_LENGTH = 10;
const SHORT_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const SHORT_CODE_RE = /^[a-z0-9]{6,16}$/;

export function generateShortCode(length: number = SHORT_CODE_LENGTH): string {
  const bytes = new Uint8Array(length);
  getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += SHORT_CODE_ALPHABET[b % 36];
  return out;
}

export function paramAsShortCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return SHORT_CODE_RE.test(value) ? value : null;
}

// ── Storage paths ───────────────────────────────────────────────────
// Local copies of host-media's sanitiser/path builder (lib/storage-paths.ts).
// Duplicated rather than imported: server-side cross-module imports are
// resolved per-snapshot at deploy time and a missing sibling checkout
// would 404 the whole route path (see project_module_api_dep_in_route_path).
// Keep the transform identical to host-media's — same bucket, same shape.

const FILENAME_MAX = 200;

export function sanitiseGuestFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = String(filename ?? '').replace(/\x00/g, '').trim();
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

export function buildGuestStoragePath(eventId: string, mediaId: string, filename: string): string {
  // host_kind is always 'event' on this path — matches host-media's
  // <hostKind>/<hostId>/<mediaId>/<filename> scheme exactly.
  return `event/${eventId}/${mediaId}/${sanitiseGuestFilename(filename)}`;
}

export function newMediaId(): string {
  return randomUUID();
}

// ── Rate limits ─────────────────────────────────────────────────────
// All windows in ms; consumed via the platform rateLimiter.check contract.

// Per-IP caps are sized for ONE venue NAT carrying the whole event —
// projector polling every 10 s plus ~100 guests browsing/uploading all
// present as a single IP at a wedding venue (evidence review 2026-09-19).
// Each op gets its OWN bucket (per-op key discriminator) so gallery
// polling can never starve uploads.
export const GUEST_RATE_LIMITS = {
  resolvePerIp: { max: 120, windowMs: 60_000 },
  mediaListPerIp: { max: 300, windowMs: 60_000 },
  mintPerClient: { max: 20, windowMs: 60_000 },
  mintPerIp: { max: 120, windowMs: 60_000 },
  completePerClient: { max: 20, windowMs: 60_000 },
  completePerIp: { max: 120, windowMs: 60_000 },
  // Per-link circuit breaker: client_id is client-chosen (spoofable), so
  // the windowed per-code cap is the real backstop against a leaked QR.
  // NOTE this caps COMPLETE CALLS; each call carries ≤20 tickets, so the
  // true file ceiling is 20× this (240 calls/hr ≈ ≤4,800 files/hr).
  completePerLinkHourly: { max: 240, windowMs: 3_600_000 },
  // Booth effects call a paid GPU endpoint, so they are capped far
  // harder than anything else. The per-guest allowance has to cover
  // actually trying the booth — there are eight or so effects and the
  // whole point is to flick through them — so it is set above the size
  // of the catalogue rather than at "a couple of goes". The per-link
  // hourly ceiling is what stops a leaked QR running up a bill.
  faceFilterPerClient: { max: 25, windowMs: 600_000 },
  faceFilterPerLinkHourly: { max: 400, windowMs: 3_600_000 },
} as const;

export function guestRateKey(op: string, discriminator: string): string {
  return `event_media:guest:${op}:${discriminator}`;
}

// ── File batch validation ───────────────────────────────────────────

export const MAX_FILES_PER_MINT = 20;
export const FILENAME_INPUT_MAX = 255;

export interface MintFileInput {
  filename: string;
  mime_type: string;
  bytes: number;
  captured: boolean;
}

export type MintFileValidation =
  | { ok: true; file: MintFileInput; kind: MediaKind }
  | { ok: false; filename: string; error: string; message: string };

export function validateMintFile(
  raw: unknown,
  link: { allow_video: boolean; max_photo_bytes: number; max_video_bytes: number },
): MintFileValidation {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const filename = typeof r['filename'] === 'string' ? r['filename'].slice(0, FILENAME_INPUT_MAX) : '';
  if (!filename) {
    return { ok: false, filename: '', error: 'invalid_request', message: 'filename required' };
  }
  const mimeType = typeof r['mime_type'] === 'string' ? r['mime_type'] : '';
  const isVideoMime = (VIDEO_MIME_ALLOWLIST as readonly string[]).includes(mimeType);
  const kind = classifyMime(mimeType, link.allow_video);
  if (!kind) {
    if (isVideoMime && !link.allow_video) {
      return { ok: false, filename, error: 'video_not_allowed', message: 'video uploads are disabled for this link' };
    }
    return { ok: false, filename, error: 'unsupported_media_type', message: `mime ${mimeType || '(missing)'} not allowed` };
  }
  const bytes = Number(r['bytes']);
  if (!Number.isFinite(bytes) || !Number.isInteger(bytes) || bytes <= 0) {
    return { ok: false, filename, error: 'invalid_request', message: 'bytes must be a positive integer' };
  }
  const cap = kind === 'photo' ? link.max_photo_bytes : link.max_video_bytes;
  if (bytes > cap) {
    return { ok: false, filename, error: 'file_too_large', message: `file exceeds the ${kind} limit`, };
  }
  const captured = r['captured'] === true;
  return { ok: true, file: { filename, mime_type: mimeType, bytes, captured }, kind };
}
