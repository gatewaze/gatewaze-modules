/**
 * Draft validation: the only fields a client can write, with their checks.
 * Mirrors the table's CHECK constraints so a bad value gets a clear 400
 * instead of a database error. Pure, so it is tested without a database.
 */

import { isFormat, isPlatform, normaliseHashtags, PLATFORMS, MAX_INSTRUCTIONS_CHARS, type Format, type Platform } from './formats.js';
import { parseItemRefs, type ItemRef } from './pool.js';

/** Statuses an editor can set. scheduled and posted belong to a later poster. */
export const EDITABLE_STATUSES = ['draft', 'ready', 'archived'] as const;
export type EditableStatus = (typeof EDITABLE_STATUSES)[number];
export const ALL_STATUSES = ['draft', 'ready', 'scheduled', 'posted', 'archived'] as const;

export const MAX_SOURCES = 10;

export interface DraftCreate {
  platform: Platform;
  format: Format;
  status: EditableStatus;
  body: string;
  hashtags: string[];
  instructions: string | null;
  ai_model: string | null;
  generated: boolean;
  sources: ItemRef[];
}

export type DraftPatch = Partial<Pick<DraftCreate, 'format' | 'status' | 'body' | 'hashtags' | 'ai_model' | 'instructions'>> & {
  /** Set when the editor regenerated the text; the route stamps generated_at. */
  regenerated?: true;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function checkBody(v: unknown, platform: Platform): Result<string> {
  if (typeof v !== 'string' || !v.trim()) return { ok: false, error: 'body is required' };
  const max = PLATFORMS[platform].maxChars;
  if (v.length > max) return { ok: false, error: `body is ${v.length} characters; ${PLATFORMS[platform].label} allows ${max}` };
  return { ok: true, value: v };
}

/** A model id as the ai module reports it, or null. Informational only. */
function modelId(v: unknown): string | null {
  return typeof v === 'string' && /^[\w.:-]{1,80}$/.test(v) ? v : null;
}

function isEditableStatus(v: unknown): v is EditableStatus {
  return typeof v === 'string' && (EDITABLE_STATUSES as readonly string[]).includes(v);
}

export function parseDraftCreate(raw: unknown): Result<DraftCreate> {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const platform = b.platform ?? 'linkedin';
  if (!isPlatform(platform)) return { ok: false, error: 'unknown platform' };
  if (!isFormat(b.format)) return { ok: false, error: 'unknown format' };
  const status = b.status ?? 'draft';
  if (!isEditableStatus(status)) return { ok: false, error: `status must be one of ${EDITABLE_STATUSES.join(', ')}` };
  const body = checkBody(b.body, platform);
  if (!body.ok) return body;
  const refs = parseItemRefs(b.sources, MAX_SOURCES);
  if (!refs.ok) return { ok: false, error: `sources: ${refs.error}` };
  let instructions: string | null = null;
  if (b.instructions != null) {
    if (typeof b.instructions !== 'string') return { ok: false, error: 'instructions must be text' };
    if (b.instructions.length > MAX_INSTRUCTIONS_CHARS) return { ok: false, error: `instructions are limited to ${MAX_INSTRUCTIONS_CHARS} characters` };
    instructions = b.instructions.trim() || null;
  }
  return {
    ok: true,
    value: {
      platform,
      format: b.format,
      status,
      body: body.value,
      hashtags: normaliseHashtags(b.hashtags, PLATFORMS[platform].hashtags.max),
      instructions,
      ai_model: modelId(b.ai_model),
      generated: b.generated === true,
      sources: refs.refs,
    },
  };
}

/** Only the fields present are changed. platform is fixed at creation. */
export function parseDraftPatch(raw: unknown, platform: Platform): Result<DraftPatch> {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: DraftPatch = {};
  if ('format' in b) {
    if (!isFormat(b.format)) return { ok: false, error: 'unknown format' };
    out.format = b.format;
  }
  if ('status' in b) {
    if (!isEditableStatus(b.status)) return { ok: false, error: `status must be one of ${EDITABLE_STATUSES.join(', ')}` };
    out.status = b.status;
  }
  if ('body' in b) {
    const body = checkBody(b.body, platform);
    if (!body.ok) return body;
    out.body = body.value;
  }
  if ('hashtags' in b) out.hashtags = normaliseHashtags(b.hashtags, PLATFORMS[platform].hashtags.max);
  if (b.regenerated === true) {
    out.regenerated = true;
    out.ai_model = modelId(b.ai_model);
    // The direction that produced the new text replaces the old one.
    if (b.instructions != null && (typeof b.instructions !== 'string' || b.instructions.length > MAX_INSTRUCTIONS_CHARS)) {
      return { ok: false, error: `instructions are limited to ${MAX_INSTRUCTIONS_CHARS} characters` };
    }
    out.instructions = typeof b.instructions === 'string' ? b.instructions.trim() || null : null;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'nothing to change' };
  return { ok: true, value: out };
}
