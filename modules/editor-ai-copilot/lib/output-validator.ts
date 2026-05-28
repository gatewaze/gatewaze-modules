/**
 * AI output validation — the application layer of the defence-in-depth
 * stack (§00000). Re-validates every block the LLM emits against its
 * library schema; drops or sanitises anything that deviates.
 *
 * Pure functions — no I/O. ajv compiled per request.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import DOMPurify from 'isomorphic-dompurify';
import type { BlockDefView, GenerateMode, PuckBlockEntry, PuckData } from './types.js';
import { canvasAiConfig } from './canvas-ai-config.js';

// Mirror of the strict richtext allowlist used in sites' Puck adapter
// (richtext-sanitize.ts) — keep in sync if either changes.
const RICHTEXT_ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'a',
  'blockquote', 'pre', 'code',
  'span',
] as const;
const RICHTEXT_ALLOWED_ATTR = ['href', 'title', 'target', 'rel'] as const;
const URL_SCHEMES_RE = /^(https?:|mailto:|tel:|\/)/i;

export interface ValidateGenerateArgs {
  /** What the LLM emitted in its tool input. */
  output: unknown;
  /** Library — used both for lookup + per-block schema. */
  blockDefs: ReadonlyArray<BlockDefView>;
  /** For mode='edit', the existing tree (used for id resolution). */
  currentData?: PuckData;
  mode: GenerateMode;
}

export interface ValidationDropReason {
  index: number;
  type: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface ValidateGenerateResult {
  data: PuckData;
  warnings: string[];
  dropReasons: ValidationDropReason[];
  blocksReturned: number;
  blocksDropped: number;
}

/**
 * Server-side UUID assignment for new blocks. Crypto must be available
 * in node (>=18 has webcrypto globally).
 */
function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback — shouldn't happen on supported runtimes.
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)] ?? '';
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sanitiseRichText(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...RICHTEXT_ALLOWED_TAGS],
    ALLOWED_ATTR: [...RICHTEXT_ALLOWED_ATTR],
    ALLOWED_URI_REGEXP: URL_SCHEMES_RE,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'svg'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  });
}

interface SchemaProp {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaProp>;
}

function isSchema(v: unknown): v is { properties?: Record<string, SchemaProp> } {
  return isRecord(v);
}

/**
 * Strip dangerous content from each string prop. Walks the block's
 * schema to determine which fields are richtext (full DOMPurify) vs
 * link (URL-scheme check) vs image (empty-string enforcement) vs
 * generic string (light strip).
 */
function sanitisePropsInPlace(
  props: Record<string, unknown>,
  schema: unknown,
  collectedWarnings: string[],
): Record<string, unknown> {
  if (!isSchema(schema) || !schema.properties) return props;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const fieldSchema = schema.properties[k];
    if (!fieldSchema) {
      // Field not in schema — ajv would have rejected the block;
      // we shouldn't get here. Skip defensively.
      continue;
    }
    if (typeof v === 'string') {
      const format = fieldSchema.format;
      if (format === 'image') {
        // §3.5 / §7.2 — AI must emit empty string for image fields.
        if (v !== '') {
          collectedWarnings.push(`image_field_dropped: ${k} (AI cannot set image URLs; user must pick via media tab)`);
          out[k] = '';
        } else {
          out[k] = '';
        }
      } else if (format === 'richtext') {
        out[k] = sanitiseRichText(v);
      } else if (format === 'link') {
        if (URL_SCHEMES_RE.test(v)) {
          out[k] = v;
        } else {
          collectedWarnings.push(`bad_link_dropped: ${k} (scheme not in https/mailto/tel/relative)`);
          out[k] = '';
        }
      } else {
        // Generic string — strip obvious HTML. We don't run DOMPurify
        // on plain strings because there's no context for tag policy;
        // simple regex strip is enough since the schema didn't ask
        // for HTML.
        let truncated = v.replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '');
        if (truncated.length > canvasAiConfig.maxFieldChars) {
          collectedWarnings.push(`field_truncated: ${k} cut to ${canvasAiConfig.maxFieldChars} chars`);
          truncated = truncated.slice(0, canvasAiConfig.maxFieldChars) + '…';
        }
        out[k] = truncated;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function validateGenerateOutput(args: ValidateGenerateArgs): ValidateGenerateResult {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  const validators = new Map<string, ValidateFunction>();
  const defsByKey = new Map<string, BlockDefView>();
  for (const def of args.blockDefs) {
    defsByKey.set(def.key, def);
    try {
      validators.set(def.key, ajv.compile(def.schema));
    } catch {
      // Schema doesn't compile — block is unusable. Will be reported
      // when the LLM attempts to emit it.
    }
  }

  const warnings: string[] = [];
  const dropReasons: ValidationDropReason[] = [];

  if (!isRecord(args.output)) {
    return {
      data: { content: [], root: { props: {} } },
      warnings: ['output_not_object'],
      dropReasons: [{ index: -1, type: '?', reason: 'output_not_object' }],
      blocksReturned: 0,
      blocksDropped: 0,
    };
  }

  const rawContent = args.output.content;
  if (!Array.isArray(rawContent)) {
    return {
      data: { content: [], root: { props: {} } },
      warnings: ['content_not_array'],
      dropReasons: [{ index: -1, type: '?', reason: 'content_not_array' }],
      blocksReturned: 0,
      blocksDropped: 0,
    };
  }

  // For edit mode, build an index of existing blocks by id so we can
  // verify type-immutability when the LLM echoes an id back.
  const existingById = new Map<string, PuckBlockEntry>();
  if (args.mode === 'edit' && args.currentData) {
    for (const e of args.currentData.content) {
      if (typeof e.props.id === 'string') existingById.set(e.props.id, e);
    }
  }

  const surviving: PuckBlockEntry[] = [];
  for (let i = 0; i < rawContent.length; i++) {
    const candidate = rawContent[i];
    if (!isRecord(candidate)) {
      dropReasons.push({ index: i, type: '?', reason: 'block_not_object' });
      continue;
    }
    const type = candidate.type;
    if (typeof type !== 'string') {
      dropReasons.push({ index: i, type: '?', reason: 'missing_type' });
      continue;
    }
    const def = defsByKey.get(type);
    if (!def) {
      dropReasons.push({ index: i, type, reason: 'unknown_block_type' });
      continue;
    }
    const propsRaw = candidate.props;
    if (!isRecord(propsRaw)) {
      dropReasons.push({ index: i, type, reason: 'missing_props' });
      continue;
    }

    // For edit-mode id-tagged entries, verify the id refers to an
    // existing block of the same type.
    let resolvedId: string | undefined;
    if (args.mode === 'edit' && typeof propsRaw.id === 'string') {
      const existing = existingById.get(propsRaw.id);
      if (!existing) {
        // Hallucinated id — treat as a fresh insert. Don't drop; warn.
        warnings.push(`ai_unmatched_id_${i}: id ${propsRaw.id} not on this page; treated as insert`);
        resolvedId = newId();
      } else if (existing.type !== type) {
        // Type change via id-match — drop (per §7.4 rule 2).
        warnings.push(`ai_id_type_mismatch_${i}: ${propsRaw.id} was ${existing.type}, LLM tried ${type}`);
        dropReasons.push({ index: i, type, reason: 'id_type_mismatch', details: { id: propsRaw.id, was: existing.type } });
        continue;
      } else {
        resolvedId = propsRaw.id;
      }
    } else {
      resolvedId = newId();
    }

    // ajv re-validation. Strip `id` from props before validating,
    // since the block's schema doesn't usually include id (server-
    // assigned). Then re-attach.
    const propsNoId: Record<string, unknown> = { ...propsRaw };
    delete propsNoId['id'];
    const validate = validators.get(type);
    if (!validate) {
      dropReasons.push({ index: i, type, reason: 'schema_uncompilable' });
      continue;
    }
    if (!validate(propsNoId)) {
      const fieldErrors = (validate.errors ?? []).map((e) => ({
        path: e.instancePath || '/',
        message: e.message ?? 'invalid',
      }));
      dropReasons.push({ index: i, type, reason: 'schema_violation', details: { field_errors: fieldErrors } });
      continue;
    }

    const sanitised = sanitisePropsInPlace(propsNoId, def.schema, warnings);
    surviving.push({
      type,
      props: { id: resolvedId, ...sanitised },
    });
  }

  return {
    data: {
      content: surviving,
      root: isRecord(args.output.root) && isRecord((args.output.root as { props?: unknown }).props)
        ? { props: (args.output.root as { props: Record<string, unknown> }).props }
        : { props: {} },
    },
    warnings,
    dropReasons,
    blocksReturned: rawContent.length,
    blocksDropped: rawContent.length - surviving.length,
  };
}

/**
 * Single-block validator for edit-block mode. Returns the new props
 * (sanitised) or an error.
 */
export function validateEditBlockOutput(
  output: unknown,
  blockDef: BlockDefView,
): { ok: true; props: Record<string, unknown>; warnings: string[] } | { ok: false; reason: string; details?: unknown } {
  if (!isRecord(output)) return { ok: false, reason: 'output_not_object' };
  const propsRaw = output.props;
  if (!isRecord(propsRaw)) return { ok: false, reason: 'missing_props' };

  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(blockDef.schema);
  } catch (err) {
    return { ok: false, reason: 'schema_uncompilable', details: err instanceof Error ? err.message : String(err) };
  }
  // Strip id if the LLM included it (we keep the existing id).
  const propsNoId: Record<string, unknown> = { ...propsRaw };
  delete propsNoId['id'];
  if (!validate(propsNoId)) {
    const fieldErrors = (validate.errors ?? []).map((e) => ({
      path: e.instancePath || '/',
      message: e.message ?? 'invalid',
    }));
    return { ok: false, reason: 'schema_violation', details: { field_errors: fieldErrors } };
  }
  const warnings: string[] = [];
  const sanitised = sanitisePropsInPlace(propsNoId, blockDef.schema, warnings);
  return { ok: true, props: sanitised, warnings };
}
