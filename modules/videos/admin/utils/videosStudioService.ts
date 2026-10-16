/**
 * Admin-side client for the studio: /api/video-editor/videos/:id/studio.
 *
 * Named and placed per the rules in videosEditorService.ts: not under
 * admin/api/, not called api.ts, and distinct across modules because every
 * admin/utils file becomes a global alias.
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.message || body.error || detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const BASE = '/api/video-editor';

export type StudioState = 'queued' | 'analysing' | 'ready' | 'finalising' | 'approved' | 'failed';

export interface StudioCut {
  key: string;
  t: number;
  url: string | null;
  bbox: [number, number, number, number] | null;
  meta: { face?: number; pose?: number; glare?: number; size?: string; note?: string; lectern?: boolean };
  glare: number;
  screen: number;
  luma: number;
  gamma: number;
  lectern_joined: boolean;
  camera_crop: boolean;
  passes: boolean;
  flagged?: string;
}

export interface StudioPanel { key: string; t: number; url: string | null; note: string; composite: boolean }

export interface StudioSpeaker { name: string; role: string | null; company: string | null; companyLogoUrl?: string | null }

export interface StudioAnalysis {
  duration: number;
  width: number;
  height: number;
  sampled: number;
  sample_every: number;
  layout: { strip: number; overlay: number; plain: number; camera_only: boolean };
  filmstrip: { url: string | null; columns: number; rows: number; cell_w: number; cell_h: number; every: number; count: number; start: number } | null;
  cuts: StudioCut[];
  panels: StudioPanel[];
  model_calls: number;
  context: { title: string; description: string | null; eventName: string | null; speakers: StudioSpeaker[]; org: string | null };
}

export interface StudioSelection {
  cut: string | null;
  scale: number;
  x: number;
  lead: string;
  emph: string;
  panels: boolean;
  trim_in: number | null;
  trim_out: number | null;
  preroll: boolean;
  card_title: string | null;
  card_speakers: Array<{ name: string; role: string | null; company: string | null }> | null;
}

export interface StudioOutputs {
  thumbnail_asset_id?: string;
  thumbnail_url?: string | null;
  master_asset_id?: string | null;
  duration_seconds?: number | null;
  reencoded?: boolean;
  trimmed?: boolean;
  prerolled?: boolean;
}

export interface StudioRow {
  id: string;
  video_id: string;
  master_asset_id: string | null;
  state: StudioState;
  progress: string | null;
  error: string | null;
  analysis: Partial<StudioAnalysis>;
  headlines: Array<{ lead: string; emph: string }>;
  selection: Partial<StudioSelection>;
  outputs: StudioOutputs;
  approved_at: string | null;
  updated_at: string;
}

export interface StudioMaster { id: string; bytes: number | null; filename: string | null; duration_seconds: number | null }

export interface StudioBrand { thumbnail_bg: string; logo: string; card_bg: string }

export interface StudioResponse {
  studio: StudioRow | null;
  master: StudioMaster | null;
  configured: boolean;
  /** Only when asked for with `withBrand`; a few hundred KB of data URIs. */
  brand?: StudioBrand;
}

export async function getStudio(videoId: string, opts: { withBrand?: boolean } = {}): Promise<StudioResponse> {
  const q = opts.withBrand ? '?brand=1' : '';
  return jsonOrThrow<StudioResponse>(await authedFetch(`${BASE}/videos/${encodeURIComponent(videoId)}/studio${q}`));
}

export async function startStudio(videoId: string): Promise<StudioRow> {
  const res = await authedFetch(`${BASE}/videos/${encodeURIComponent(videoId)}/studio`, { method: 'POST', body: '{}' });
  return (await jsonOrThrow<{ studio: StudioRow }>(res)).studio;
}

export async function saveSelection(videoId: string, selection: Partial<StudioSelection>): Promise<StudioRow> {
  const res = await authedFetch(`${BASE}/videos/${encodeURIComponent(videoId)}/studio/selection`, {
    method: 'PATCH', body: JSON.stringify(selection),
  });
  return (await jsonOrThrow<{ studio: StudioRow }>(res)).studio;
}

export async function approveStudio(videoId: string, selection: Partial<StudioSelection>): Promise<StudioRow> {
  const res = await authedFetch(`${BASE}/videos/${encodeURIComponent(videoId)}/studio/approve`, {
    method: 'POST', body: JSON.stringify({ selection }),
  });
  return (await jsonOrThrow<{ studio: StudioRow }>(res)).studio;
}

export async function getVideoSummary(videoId: string): Promise<{ title: string; kind: string } | null> {
  const { data } = await supabase.from('videos').select('title, kind').eq('id', videoId).maybeSingle();
  return data ? { title: String(data.title ?? ''), kind: String(data.kind ?? 'full') } : null;
}

export function mmss(s: number): string {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}
