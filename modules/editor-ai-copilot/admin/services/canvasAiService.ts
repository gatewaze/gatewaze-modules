/**
 * Browser-side fetch wrappers for the canvas-ai endpoints. Every call
 * attaches the user's Supabase access token as Bearer (same pattern
 * as host-media + canvas-service).
 */

import { supabase } from '@/lib/supabase';
import type { PuckData } from '../components/puck-data-merger.js';

const API_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  return fetch(`${API_URL}${path}`, { ...init, headers });
}

export type HostKind = 'site' | 'newsletter';

export type GenerateMode = 'replace' | 'append' | 'insert-after' | 'edit' | 'edit-block';

export interface GenerateRequest {
  host_kind: HostKind;
  host_id: string;
  target_id: string;
  prompt: string;
  mode: GenerateMode;
  anchorBlockId?: string;
  blockId?: string;
  doc_ids?: string[];
  /**
   * Optional client-supplied block defs. When present, the server uses
   * these instead of querying `templates_block_defs`. Required for
   * hosts whose libraries aren't backed by DB rows (newsletters with
   * react-email registry blocks). The server still ajv-compiles every
   * supplied schema and rejects malformed entries — passing arbitrary
   * data here doesn't escape validation.
   */
  block_defs?: ReadonlyArray<Record<string, unknown>>;
}

export interface GenerateUsage {
  input_tokens: number;
  output_tokens: number;
  provider: 'anthropic' | 'openai';
  model: string;
  duration_ms: number;
}

export interface GenerateResponse {
  data: PuckData;
  warnings: string[];
  usage: GenerateUsage;
  audit_id: string | null;
}

export interface AiServiceError {
  code: string;
  message: string;
  retryAfter?: number;
  details?: Record<string, unknown>;
  httpStatus: number;
}

export type GenerateResult =
  | { ok: true; response: GenerateResponse }
  | { ok: false; error: AiServiceError };

async function parseError(res: Response): Promise<AiServiceError> {
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // non-JSON
  }
  const retryAfterHeader = res.headers.get('Retry-After');
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  return {
    code: body.error?.code ?? `http_${res.status}`,
    message: body.error?.message ?? `Request failed (${res.status})`,
    httpStatus: res.status,
    ...(retryAfter && !Number.isNaN(retryAfter) ? { retryAfter } : {}),
    ...(body.error?.details ? { details: body.error.details } : {}),
  };
}

export const CanvasAiService = {
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await authedFetch('/api/admin/modules/editor-ai-copilot/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) return { ok: false, error: await parseError(res) };
    const response = (await res.json()) as GenerateResponse;
    return { ok: true, response };
  },

  // Phase F — file upload.
  async uploadDocument(args: {
    file: File;
    host_kind: HostKind;
    host_id: string;
    target_id: string;
  }): Promise<{ ok: true; doc_id: string; filename: string; warnings: string[] } | { ok: false; error: AiServiceError }> {
    const fd = new FormData();
    fd.append('file', args.file);
    fd.append('host_kind', args.host_kind);
    fd.append('host_id', args.host_id);
    fd.append('target_id', args.target_id);
    const res = await authedFetch('/api/admin/modules/editor-ai-copilot/documents', {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) return { ok: false, error: await parseError(res) };
    const body = (await res.json()) as { doc_id: string; filename: string; warnings: string[] };
    return { ok: true, doc_id: body.doc_id, filename: body.filename, warnings: body.warnings };
  },

  // Phase F — URL ingestion.
  async uploadDocumentFromUrl(args: {
    url: string;
    host_kind: HostKind;
    host_id: string;
    target_id: string;
  }): Promise<{ ok: true; doc_id: string; filename: string; warnings: string[] } | { ok: false; error: AiServiceError }> {
    const res = await authedFetch('/api/admin/modules/editor-ai-copilot/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) return { ok: false, error: await parseError(res) };
    const body = (await res.json()) as { doc_id: string; filename: string; warnings: string[] };
    return { ok: true, doc_id: body.doc_id, filename: body.filename, warnings: body.warnings };
  },
};
