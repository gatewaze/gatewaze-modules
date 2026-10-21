/**
 * What an editor may upload into the studio, decided without I/O.
 *
 * Three kinds: a company logo for the talk, a photo of the speaker to cut
 * out instead of a frame from the video, and an image to use as a
 * background panel instead of a slide from the video.
 */

export type StudioUploadKind = 'logo' | 'speaker' | 'background';

const KINDS: Record<StudioUploadKind, { mimes: string[]; maxBytes: number }> = {
  logo: { mimes: ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'], maxBytes: 2 * 1024 * 1024 },
  speaker: { mimes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 20 * 1024 * 1024 },
  background: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 20 * 1024 * 1024 },
};

const EXT: Record<string, string> = { 'image/png': 'png', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export interface UploadSpec { kind: StudioUploadKind; mime: string; bytes: number; ext: string }

/** The cleaned request, or the reason it is refused. */
export function uploadSpec(kind: unknown, mime: unknown, bytes: unknown): { ok: true; spec: UploadSpec } | { ok: false; error: string } {
  const k = String(kind ?? '') as StudioUploadKind;
  if (!(k in KINDS)) return { ok: false, error: 'kind must be logo, speaker or background' };
  const m = String(mime ?? '').toLowerCase().trim();
  if (!KINDS[k].mimes.includes(m)) return { ok: false, error: `a ${k} must be ${KINDS[k].mimes.map((x) => x.split('/')[1]).join(', ')}` };
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return { ok: false, error: 'bytes is required' };
  if (b > KINDS[k].maxBytes) return { ok: false, error: `a ${k} must be under ${Math.round(KINDS[k].maxBytes / 1048576)} MB` };
  return { ok: true, spec: { kind: k, mime: m, bytes: Math.round(b), ext: EXT[m] } };
}

export function maxBytesFor(kind: StudioUploadKind): number {
  return KINDS[kind].maxBytes;
}

/** An entry on the studio row's pending_uploads list. */
export interface PendingUpload { path: string; kind: StudioUploadKind; mime: string; bytes: number; by: string | null; at: string }

/** Pending uploads minus the stale ones; a signed upload lives two hours. */
export function prunePending(list: unknown, nowMs = Date.now()): PendingUpload[] {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p.path === 'string' && Number.isFinite(Date.parse(String(p.at))) && nowMs - Date.parse(String(p.at)) < 2 * 3600_000) as PendingUpload[];
}
