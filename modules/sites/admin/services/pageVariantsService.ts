/**
 * Browser-side wrapper for the page-variants admin endpoints
 * (sites/api/page-variants-routes.ts).
 *
 * Per spec-aaif-theme-deliverable §5.2.
 *
 * Mirrors the conventions in personasService.ts — supabase session token,
 * apiFetch() helper for the actual call. Returns `{ value, error }`
 * tuples so call sites can flat-handle errors.
 */

import { supabase } from '@/lib/supabase';

export interface PageVariant {
  id: string;
  page_id: string;
  field_path: string;
  match_context: Record<string, unknown>;
  value: unknown;
  priority: number;
  persona_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ErrorResponse {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T | null; error: string | null }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const apiUrl =
    (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';

  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${apiUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    let message: string;
    try {
      const body = (await res.json()) as ErrorResponse;
      message = body.message ?? body.error ?? `HTTP ${res.status}`;
    } catch {
      message = `HTTP ${res.status}`;
    }
    return { data: null, error: message };
  }
  if (res.status === 204) return { data: null, error: null };
  const body = (await res.json()) as T;
  return { data: body, error: null };
}

export interface CreateVariantArgs {
  pageId: string;
  field_path: string;
  match_context: Record<string, unknown>;
  value: unknown;
  priority?: number;
  persona_id?: string | null;
}

export interface UpdateVariantArgs {
  pageId: string;
  variantId: string;
  patch: Partial<Omit<CreateVariantArgs, 'pageId'>>;
}

export const PageVariantsService = {
  async list(pageId: string): Promise<{ variants: PageVariant[]; error: string | null }> {
    const { data, error } = await apiFetch<{ variants: PageVariant[] }>(
      `/api/admin/pages/${encodeURIComponent(pageId)}/variants`,
    );
    if (error) return { variants: [], error };
    return { variants: data?.variants ?? [], error: null };
  },

  async create(args: CreateVariantArgs): Promise<{ variant: PageVariant | null; error: string | null }> {
    const { pageId, ...body } = args;
    const { data, error } = await apiFetch<PageVariant>(
      `/api/admin/pages/${encodeURIComponent(pageId)}/variants`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return { variant: data, error };
  },

  async update(args: UpdateVariantArgs): Promise<{ variant: PageVariant | null; error: string | null }> {
    const { pageId, variantId, patch } = args;
    const { data, error } = await apiFetch<PageVariant>(
      `/api/admin/pages/${encodeURIComponent(pageId)}/variants/${encodeURIComponent(variantId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    return { variant: data, error };
  },

  async delete(pageId: string, variantId: string): Promise<{ error: string | null }> {
    const { error } = await apiFetch<void>(
      `/api/admin/pages/${encodeURIComponent(pageId)}/variants/${encodeURIComponent(variantId)}`,
      { method: 'DELETE' },
    );
    return { error };
  },
};
