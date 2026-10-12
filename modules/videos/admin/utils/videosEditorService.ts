/**
 * Admin-side client for the videos editor surface.
 *
 * Talks to /api/video-editor/* with the operator's bearer token. That prefix
 * rather than /api/modules/videos/* because the platform super-admin-gates the
 * whole /api/modules tree.
 *
 * The filename matters. The admin vite plugin stubs any relative import
 * matching `./api*`, `./workers*`, `./functions*`, `./mcp*`,
 * `./register-routes*` or `./cli*` as server-only, silently replacing the
 * export with a no-op. So this cannot live in `admin/api/` or be called
 * `api.ts`. It is also named distinctively because every
 * `<module>/admin/utils/<name>.ts` is registered as a global `@/utils/<name>`
 * alias, first-wins across modules.
 */

import { supabase } from '@/lib/supabase';

function apiUrl(): string {
  return (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.message || body.error || detail;
    } catch {
      /* non-JSON error page */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const BASE = '/api/video-editor';

// ── Types ────────────────────────────────────────────────────────────────────

export type SubjectType = 'event' | 'podcast';
export type AssetKind = 'master' | 'short' | 'caption' | 'thumbnail';
export type Visibility = 'public' | 'unlisted' | 'private';

export interface EditorScope {
  is_admin: boolean;
  unrestricted: boolean;
  uploads_available: boolean;
  grants: Array<{
    subject_type: string;
    subject_id: string | null;
    can_upload: boolean;
    can_schedule: boolean;
  }>;
}

export interface SubjectOption {
  id: string;
  label: string;
  reference?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
}

export interface UnitOption {
  id: string;
  label: string;
  starts_at?: string | null;
  talk_id?: string | null;
  videos: { full: number; short: number };
}

export interface VideoAsset {
  id: string;
  video_id: string;
  kind: AssetKind;
  state: 'uploading' | 'ready' | 'failed' | 'superseded';
  bytes: number | null;
  mime_type: string | null;
  filename: string | null;
  duration_seconds: number | null;
}

export interface VideoPublication {
  id: string;
  video_id: string;
  platform: string;
  state: string;
  scheduled_for: string | null;
  requested_visibility: Visibility;
  external_url: string | null;
  last_error: string | null;
  published_at: string | null;
}

export interface EditorVideo {
  id: string;
  title: string;
  kind: string;
  derived_from_video_id: string | null;
  status: string;
  visibility: string;
  duration_seconds: number | null;
  assets: VideoAsset[];
  publications: VideoPublication[];
}

export interface GeneratedCopy {
  title: string;
  description: string;
  posts: Array<{ key: string; text: string }>;
  titlesByPlatform: Record<string, string>;
}

export interface MintedFile {
  filename: string;
  status: 'ready' | 'rejected' | 'failed';
  reason?: string;
  kind?: AssetKind;
  video_id?: string;
  asset_id?: string;
  storage_path?: string;
  upload_url?: string;
  ticket?: string;
}

// ── Calls ────────────────────────────────────────────────────────────────────

export async function getScope(): Promise<EditorScope> {
  return jsonOrThrow<EditorScope>(await authedFetch(`${BASE}/scope`));
}

/**
 * Subjects to pick from.
 *
 * Events are filtered to PAST ones server-side, because an editor uploads a
 * recording of something that has already happened and the brand has nearly a
 * thousand events. Podcasts are not filtered: a podcast is ongoing, so "past"
 * means nothing for one.
 *
 * `search` is passed to the server rather than filtering in the browser. The
 * list is capped at 200 rows, so filtering what arrived would silently hide
 * any match past the cap.
 */
export async function listSubjects(
  type: SubjectType,
  search = '',
): Promise<{ subjects: SubjectOption[]; truncated: boolean }> {
  const q = search.trim() ? `&q=${encodeURIComponent(search.trim())}` : '';
  const res = await authedFetch(`${BASE}/subjects?type=${encodeURIComponent(type)}${q}`);
  const body = await jsonOrThrow<{ subjects: SubjectOption[]; truncated?: boolean }>(res);
  return { subjects: body.subjects ?? [], truncated: body.truncated === true };
}

export async function listUnits(type: SubjectType, subjectId: string): Promise<UnitOption[]> {
  const res = await authedFetch(
    `${BASE}/subjects/${encodeURIComponent(type)}/${encodeURIComponent(subjectId)}/units`,
  );
  return (await jsonOrThrow<{ units: UnitOption[] }>(res)).units;
}

export async function listUnitVideos(
  type: SubjectType,
  subjectId: string,
  unitId: string,
): Promise<EditorVideo[]> {
  const res = await authedFetch(
    `${BASE}/subjects/${encodeURIComponent(type)}/${encodeURIComponent(subjectId)}/units/${encodeURIComponent(unitId)}/videos`,
  );
  return (await jsonOrThrow<{ videos: EditorVideo[] }>(res)).videos;
}

// ── Triage: videos belonging to nothing yet ──────────────────────────────────

/** What a discovered video can be attached to. */
export type AssignSubjectType = 'event' | 'podcast' | 'agenda_entry' | 'podcast_episode';

export interface UnassignedVideo {
  id: string;
  provider: string;
  title: string | null;
  url: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  channel_title: string | null;
  kind: string | null;
  connection_label: string | null;
  /** Null when no metric has been collected yet, which is not the same as 0. */
  latest_views: number | null;
  views_as_of: string | null;
}

export interface UnassignedPage {
  videos: UnassignedVideo[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The triage queue, newest-first by view count.
 *
 * Paged server-side. Connecting an account adopts its whole back catalogue, so
 * this list starts at several hundred rows on a real brand and loading it all
 * would be both slow and useless.
 */
export async function listUnassigned(
  opts: { limit?: number; offset?: number; provider?: string; search?: string } = {},
): Promise<UnassignedPage> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 50),
    offset: String(opts.offset ?? 0),
  });
  if (opts.provider) params.set('provider', opts.provider);
  if (opts.search?.trim()) params.set('q', opts.search.trim());
  const res = await authedFetch(`${BASE}/unassigned?${params}`);
  const body = await jsonOrThrow<Partial<UnassignedPage>>(res);
  return {
    videos: body.videos ?? [],
    total: body.total ?? 0,
    limit: body.limit ?? 50,
    offset: body.offset ?? 0,
  };
}

export async function unassignedSummary(): Promise<{
  total: number;
  byProvider: Record<string, number>;
  /** Platforms whose count could not be read, so the total is short. */
  unreadable: string[];
}> {
  const res = await authedFetch(`${BASE}/unassigned/summary`);
  const body = await jsonOrThrow<{
    total?: number;
    by_provider?: Record<string, number>;
    unreadable?: string[];
  }>(res);
  return {
    total: body.total ?? 0,
    byProvider: body.by_provider ?? {},
    unreadable: body.unreadable ?? [],
  };
}

/** Attach one video to an event, podcast, talk or episode. */
export async function assignVideo(
  videoId: string,
  subjectType: AssignSubjectType,
  subjectId: string,
): Promise<void> {
  const res = await authedFetch(`${BASE}/unassigned/${encodeURIComponent(videoId)}/assign`, {
    method: 'POST',
    body: JSON.stringify({ subject_type: subjectType, subject_id: subjectId }),
  });
  await jsonOrThrow<unknown>(res);
}

export async function getCopy(videoId: string, platforms: string[] = ['youtube']): Promise<GeneratedCopy> {
  const res = await authedFetch(
    `${BASE}/videos/${encodeURIComponent(videoId)}/copy?platforms=${encodeURIComponent(platforms.join(','))}`,
  );
  return (await jsonOrThrow<{ copy: GeneratedCopy }>(res)).copy;
}

export async function mintUploads(args: {
  subjectType: SubjectType;
  subjectId: string;
  unitId: string;
  files: Array<{ filename: string; mime_type: string; bytes: number; kind: AssetKind; title?: string }>;
}): Promise<MintedFile[]> {
  const res = await authedFetch(`${BASE}/uploads/mint`, {
    method: 'POST',
    body: JSON.stringify({
      subject_type: args.subjectType,
      subject_id: args.subjectId,
      unit_id: args.unitId,
      files: args.files,
    }),
  });
  return (await jsonOrThrow<{ files: MintedFile[] }>(res)).files;
}

export async function completeUpload(args: {
  ticket: string;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
}): Promise<{ status: string; asset_id: string; video_id: string }> {
  const res = await authedFetch(`${BASE}/uploads/complete`, {
    method: 'POST',
    body: JSON.stringify({
      ticket: args.ticket,
      duration_seconds: args.durationSeconds ?? undefined,
      width: args.width ?? undefined,
      height: args.height ?? undefined,
    }),
  });
  return jsonOrThrow(res);
}

export async function schedulePublication(args: {
  videoId: string;
  subjectType: SubjectType;
  subjectId: string;
  platform: string;
  visibility: Visibility;
  /** ISO instant, or null to queue immediately. */
  scheduledFor: string | null;
  title?: string;
  description?: string;
}): Promise<VideoPublication> {
  const res = await authedFetch(`${BASE}/videos/${encodeURIComponent(args.videoId)}/publications`, {
    method: 'POST',
    body: JSON.stringify({
      subject_type: args.subjectType,
      subject_id: args.subjectId,
      platform: args.platform,
      requested_visibility: args.visibility,
      scheduled_for: args.scheduledFor,
      title: args.title,
      description: args.description,
    }),
  });
  return (await jsonOrThrow<{ publication: VideoPublication }>(res)).publication;
}

export async function updatePublication(
  id: string,
  patch: { scheduled_for?: string | null; requested_visibility?: Visibility; cancel?: boolean },
): Promise<VideoPublication> {
  const res = await authedFetch(`${BASE}/publications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return (await jsonOrThrow<{ publication: VideoPublication }>(res)).publication;
}

export async function getPlaybackUrl(assetId: string): Promise<string> {
  const res = await authedFetch(`${BASE}/assets/${encodeURIComponent(assetId)}/playback`);
  return (await jsonOrThrow<{ url: string }>(res)).url;
}

// ── Upload helper ────────────────────────────────────────────────────────────

/**
 * PUT one file straight to storage, with progress.
 *
 * XHR rather than fetch because fetch has no upload-progress event, which is
 * the same reason event-media's MediaUploadModal uses XHR. The difference here
 * is that this goes to the signed storage URL, not through the API, so the
 * 50MB multer and body-parser limits never apply and a 2GB master is viable.
 */
export function putToStorage(
  uploadUrl: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    // The stored Content-Type is what the complete step enforces against the
    // ticket, so it has to be the type that was declared at mint.
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed: HTTP ${xhr.status}`));
    };
    if (signal) {
      signal.addEventListener('abort', () => {
        xhr.abort();
        reject(new Error('Upload cancelled'));
      }, { once: true });
    }
    xhr.send(file);
  });
}

/**
 * Read duration and dimensions from the file in the browser.
 *
 * Nothing server-side can do this: there is no ffprobe anywhere in the
 * codebase. So these are client-reported hints, stored as given, and nothing
 * security-relevant depends on them. Resolves with nulls rather than
 * rejecting, because a missing duration must not block an upload.
 */
export function probeVideo(file: File): Promise<{ duration: number | null; width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('video/')) {
      resolve({ duration: null, width: null, height: null });
      return;
    }
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    let settled = false;
    const done = (r: { duration: number | null; width: number | null; height: number | null }) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(r);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done({
      duration: Number.isFinite(el.duration) ? Math.round(el.duration) : null,
      width: el.videoWidth || null,
      height: el.videoHeight || null,
    });
    el.onerror = () => done({ duration: null, width: null, height: null });
    // A codec the browser cannot decode never fires either event.
    setTimeout(() => done({ duration: null, width: null, height: null }), 10_000);
    el.src = url;
  });
}

/** Human bytes, for the queue list. */
export function formatBytes(bytes: number | null | undefined): string {
  const b = Number(bytes ?? 0);
  if (!Number.isFinite(b) || b <= 0) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

/**
 * A naive `datetime-local` value to an ISO instant, interpreted as UTC.
 *
 * Copied from the platform's SendingPanel, which made the same choice for
 * scheduled sends, so the two schedulers agree: the time an operator types is
 * the time in UTC, and the UI labels it so. Interpreting it in the browser's
 * zone instead would mean the same input produced different results depending
 * on who typed it.
 */
export function scheduleInputToIso(s: string): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi)).toISOString();
}

/** The `min` attribute for a schedule input: now plus a minute, in UTC. */
export function scheduleMinValue(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
