/**
 * Browser-side wrapper for the personas admin endpoints
 * (sites/api/personas-routes.ts).
 *
 * Per spec-aaif-theme-deliverable §5.2.
 *
 * Mirrors the conventions in sitesService.ts — `supabase` for token,
 * apiFetch() helper for the actual call. Returns `{ value, error }`
 * tuples so call sites can flat-handle errors.
 */

import { supabase } from '@/lib/supabase';

const KNOWN_AXES = [
  'persona',
  'utm.source',
  'utm.medium',
  'utm.campaign',
  'utm.term',
  'utm.content',
  'geo.country',
  'geo.region',
  'geo.city',
  'locale',
  'viewer.authenticated',
  '*self_select',
] as const;

export type PersonaAxis = (typeof KNOWN_AXES)[number];
export const PERSONA_AXES: ReadonlyArray<PersonaAxis> = KNOWN_AXES;

const KNOWN_OPERATORS = ['eq', 'in', 'exists', 'not_eq'] as const;
export type PersonaOperator = (typeof KNOWN_OPERATORS)[number];
export const PERSONA_OPERATORS: ReadonlyArray<PersonaOperator> = KNOWN_OPERATORS;

export interface PersonaCondition {
  axis: PersonaAxis;
  operator: PersonaOperator;
  /**
   * Shape depends on operator:
   *   eq / not_eq → string | boolean (boolean only for viewer.authenticated)
   *   in          → array of strings
   *   exists      → null
   * `*self_select` is always { operator: 'eq', value: null }.
   */
  value: string | boolean | null | readonly string[];
  persist: boolean;
}

export interface Persona {
  id: string;
  site_id: string;
  name: string;
  label: string;
  description: string | null;
  is_default: boolean;
  priority: number;
  conditions: PersonaCondition[];
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

export interface CreatePersonaArgs {
  siteId: string;
  name: string;
  label: string;
  description?: string | null;
  is_default?: boolean;
  priority?: number;
  conditions?: PersonaCondition[];
}

export interface UpdatePersonaArgs {
  siteId: string;
  personaId: string;
  patch: Partial<Omit<CreatePersonaArgs, 'siteId'>>;
}

export interface TestResolveResult {
  render_context: Record<string, unknown>;
  resolved: {
    persona: Persona;
    matched_condition: PersonaCondition | null;
  } | null;
}

export const PersonasService = {
  async list(siteId: string): Promise<{ personas: Persona[]; error: string | null }> {
    const { data, error } = await apiFetch<{ personas: Persona[] }>(
      `/api/admin/sites/${encodeURIComponent(siteId)}/personas`,
    );
    if (error) return { personas: [], error };
    return { personas: data?.personas ?? [], error: null };
  },

  async get(siteId: string, personaId: string): Promise<{ persona: Persona | null; error: string | null }> {
    const { data, error } = await apiFetch<Persona>(
      `/api/admin/sites/${encodeURIComponent(siteId)}/personas/${encodeURIComponent(personaId)}`,
    );
    return { persona: data, error };
  },

  async create(args: CreatePersonaArgs): Promise<{ persona: Persona | null; error: string | null }> {
    const { siteId, ...body } = args;
    const { data, error } = await apiFetch<Persona>(
      `/api/admin/sites/${encodeURIComponent(siteId)}/personas`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return { persona: data, error };
  },

  async update(args: UpdatePersonaArgs): Promise<{ persona: Persona | null; error: string | null }> {
    const { siteId, personaId, patch } = args;
    const { data, error } = await apiFetch<Persona>(
      `/api/admin/sites/${encodeURIComponent(siteId)}/personas/${encodeURIComponent(personaId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    return { persona: data, error };
  },

  async delete(siteId: string, personaId: string): Promise<{ error: string | null }> {
    const { error } = await apiFetch<void>(
      `/api/admin/sites/${encodeURIComponent(siteId)}/personas/${encodeURIComponent(personaId)}`,
      { method: 'DELETE' },
    );
    return { error };
  },

  async testResolve(args: {
    siteId: string;
    renderContext: Record<string, unknown>;
  }): Promise<{ result: TestResolveResult | null; error: string | null }> {
    const { data, error } = await apiFetch<TestResolveResult>(
      `/api/admin/sites/${encodeURIComponent(args.siteId)}/personas/test-resolve`,
      { method: 'POST', body: JSON.stringify({ render_context: args.renderContext }) },
    );
    return { result: data, error };
  },
};
