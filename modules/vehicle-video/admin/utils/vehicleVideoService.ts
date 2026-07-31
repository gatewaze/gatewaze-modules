/**
 * Admin-side client for the Vehicle Video REST surface. Talks to
 * /api/modules/vehicle-video/* with the operator's bearer token.
 */

import { supabase } from '@/lib/supabase';

function apiUrl(): string {
  // The admin app proxies /api to the platform API.
  return '';
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  const res = await fetch(`${apiUrl()}/api/modules/vehicle-video${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export interface StockVehicle {
  listing_id: string;
  url: string;
  title?: string;
  price?: string;
  mileage?: string;
  thumbnail_url?: string;
}

export interface StyleProfile {
  vehicle_character: string;
  audience?: {
    summary?: string;
    buyer_motivations?: string[];
    market_read?: string;
    lifestyle?: string;
    age_lean?: string;
    notes?: string;
  };
  style?: { pacing?: string; camera_energy?: string; tone?: string; voice?: string };
  rationale?: string;
}

export interface Run {
  id: string;
  input_mode: 'url' | 'upload';
  source_url?: string | null;
  market?: string | null;
  vehicle?: Record<string, unknown>;
  photo_paths?: string[];
  style_profile?: StyleProfile | null;
  script_status: string;
  video_status: string;
  video_config?: Record<string, unknown>;
  voiceover_text?: string | null;
  video_path?: string | null;
  cost_micro_usd?: number;
  preview_path?: string | null;
  preview_status?: 'idle' | 'generating' | 'ready' | 'failed';
  error?: { code: string; phase: string; message: string; at: string } | null;
  created_at: string;
  updated_at?: string;
}

export interface Shot {
  id: string;
  seq: number;
  beat: string;
  part?: string | null;
  photo_path: string;
  alt_photo_paths?: string[];
  scene_title?: string | null;
  narration?: string | null;
  camera_prompt?: string | null;
  kept: boolean;
  clip_path?: string | null;
  clip_status: string;
  approval_status: 'pending' | 'approved' | 'rejected';
  regen_count: number;
  fidelity_note?: string | null;
  needs_more_images?: boolean;
  error?: { code: string; message: string } | null;
}

export const listInventory = () =>
  req<{ fetched_at: string; stale: boolean; vehicles: StockVehicle[] }>('/inventory');
export const refreshInventory = () => req<{}>('/inventory/refresh', { method: 'POST' });

export const listRuns = () => req<{ runs: Run[] }>('/runs');
export const getRun = (id: string) => req<{ run: Run; shots: Shot[] }>(`/runs/${id}`);

export const createRunFromListing = (listing_id: string, market?: string) =>
  req<{ id: string; script_status: string }>('/runs', {
    method: 'POST',
    body: JSON.stringify({ input_mode: 'url', listing_id, ...(market ? { market } : {}) }),
  });

export const createRunFromUrl = (source_url: string, market?: string) =>
  req<{ id: string; script_status: string }>('/runs', {
    method: 'POST',
    body: JSON.stringify({ input_mode: 'url', source_url, ...(market ? { market } : {}) }),
  });

export const createUploadRun = (market?: string) =>
  req<{ id: string; script_status: string }>('/runs', {
    method: 'POST',
    body: JSON.stringify({ input_mode: 'upload', ...(market ? { market } : {}) }),
  });

export const uploadPhotos = (id: string, photos: Array<{ filename: string; base64: string }>, final: boolean) =>
  req<{ id: string; photo_paths: string[]; script_status: string }>(`/runs/${id}/photos`, {
    method: 'POST',
    body: JSON.stringify({ photos, final }),
  });

export const patchStyle = (id: string, patch: { vehicle_character?: string; market?: string; style?: Record<string, string> }) =>
  req<{ run: Run }>(`/runs/${id}/style`, { method: 'PATCH', body: JSON.stringify(patch) });

export const patchShots = (id: string, shots: Array<{ id: string; narration?: string; camera_prompt?: string; kept?: boolean }>) =>
  req<{ run: Run; shots: Shot[] }>(`/runs/${id}/shots`, { method: 'PATCH', body: JSON.stringify({ shots }) });

export const rescript = (id: string) => req<{ id: string; script_status: string }>(`/runs/${id}/rescript`, { method: 'POST' });
export const approvePlan = (id: string) => req<{ id: string; video_status: string }>(`/runs/${id}/approve-plan`, { method: 'POST' });
export const generateShot = (shotId: string) => req<{ id: string; status: string }>(`/shots/${shotId}/generate`, { method: 'POST' });
export const approveShot = (shotId: string) => req<{ shot: Shot }>(`/shots/${shotId}/approve`, { method: 'POST' });
export const regenerateShot = (shotId: string, useAlt = false) =>
  req<{ shot: Shot }>(`/shots/${shotId}/regenerate`, { method: 'POST', body: JSON.stringify({ use_alt: useAlt }) });

// ── Promo (single short, self-aware social clip) ────────────────────────────
export interface PromoTheme {
  id: string;
  title: string;
  description: string;
  best_for?: string;
  shots: number;
  title_card: { headline: string; cta: string } | null;
}
export const listPromoThemes = () => req<{ themes: PromoTheme[] }>(`/themes`);
export const generatePromo = (id: string, themeId: string) =>
  req<{ id: string; theme_id: string; video_status: string }>(
    `/runs/${id}/promo`, { method: 'POST', body: JSON.stringify({ theme_id: themeId }) });

export interface Watermark {
  enabled: boolean;
  logo_path: string | null;
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  scale: number;
  opacity: number;
}
export const getBranding = () => req<{ watermark: Watermark; logo_url: string | null }>('/branding');
export const uploadLogo = (base64: string) => req<{ watermark: Watermark }>('/branding/logo', { method: 'POST', body: JSON.stringify({ base64 }) });
export const autopullLogo = () => req<{ watermark: Watermark; source_url: string }>('/branding/logo/autopull', { method: 'POST' });
export const updateWatermark = (patch: Partial<Watermark>) => req<{ watermark: Watermark }>('/branding', { method: 'PUT', body: JSON.stringify(patch) });

export const previewRun = (id: string) => req<{ id: string; preview_status: string }>(`/runs/${id}/preview`, { method: 'POST' });
export const finalizeRun = (id: string) => req<{ id: string; video_status: string }>(`/runs/${id}/finalize`, { method: 'POST' });
export const deleteRun = (id: string) => req<void>(`/runs/${id}`, { method: 'DELETE' });

/** Public media URL for a storage path. */
export function mediaUrl(path: string): string {
  const base = (import.meta as any).env?.VITE_SUPABASE_URL ?? '';
  return `${base}/storage/v1/object/public/media/${path}`;
}

export const ACTIVE_SCRIPT = ['scraping', 'styling', 'scripting'];
export const ACTIVE_VIDEO = ['clips_in_progress', 'finalizing'];
