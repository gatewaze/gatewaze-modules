/**
 * Build the block-def view that the AI copilot needs to constrain its
 * output, sourced from BOTH:
 *
 *   - `blockTemplates` (DB-backed Mustache templates the user authored)
 *   - `emailBlockRegistry` (react-email components shipped as code)
 *
 * The AI copilot lives in a separate (premium) module and queries
 * `templates_block_defs` by default — that surface only carries the DB
 * half of the library. For newsletters the registry half is the
 * dominant one (and the user's library may have zero DB rows), so we
 * supply the full merged set to the AI plugin via
 * `CanvasPluginHostContext.blockDefs`. The server-side generate handler
 * uses the request-supplied defs when present, bypassing the DB query.
 *
 * Conversion rules — Puck `Field` config → JSON Schema property:
 *
 *   - `text` / `textarea`              → { type: 'string' }
 *   - `number`                          → { type: 'number' }
 *   - `radio` / `select`               → { type: 'string', enum: [...] }
 *   - `array`                          → { type: 'array', items: {} }
 *   - `object`                         → { type: 'object', properties: {...} }
 *   - `slot`                           → omitted (AI doesn't generate children
 *                                        — that's the user's drag-and-drop job)
 *   - `custom`                         → { type: 'string', format: 'image' }
 *                                        (treat all custom fields as
 *                                        image-like: AI emits empty string,
 *                                        the output validator force-clears
 *                                        and the user picks via the field's
 *                                        custom UI)
 */

import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry, EmailBlockRegistry } from './registry-types.js';
import type { BlockTemplate } from '../../../utils/types.js';

export interface AiBlockDefView {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  schema: Record<string, unknown>;
  has_bricks: boolean;
  theme_kind: 'website' | 'email';
}

interface JsonSchemaProperty {
  type?: string;
  format?: string;
  enum?: string[];
  items?: Record<string, unknown>;
  properties?: Record<string, JsonSchemaProperty>;
}

function fieldToJsonSchemaProp(field: Field): JsonSchemaProperty | null {
  if (!field || typeof field !== 'object') return null;
  const f = field as { type: string } & Record<string, unknown>;
  switch (f.type) {
    case 'text':
    case 'textarea':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'radio':
    case 'select': {
      const options = Array.isArray(f.options) ? (f.options as Array<{ value: unknown }>) : [];
      const values = options
        .map((o) => (typeof o.value === 'string' ? o.value : null))
        .filter((v): v is string => v !== null);
      return values.length > 0
        ? { type: 'string', enum: values }
        : { type: 'string' };
    }
    case 'array':
      return { type: 'array', items: {} };
    case 'object': {
      const objectFields = (f.objectFields ?? {}) as Record<string, Field>;
      const properties: Record<string, JsonSchemaProperty> = {};
      for (const [k, v] of Object.entries(objectFields)) {
        const p = fieldToJsonSchemaProp(v);
        if (p) properties[k] = p;
      }
      return { type: 'object', properties };
    }
    case 'slot':
      // Skip — children are user-controlled drag-and-drop content,
      // not AI-generated. Omitting from the schema makes ajv reject
      // any attempt by the LLM to supply children.
      return null;
    case 'custom':
      // Treated as image-like: AI emits empty string, the output
      // validator forces it to '' and the user picks via the field's
      // custom adapter UI after generation. Matches the field-type
      // contract on the server side (`format: 'image'`).
      return { type: 'string', format: 'image' };
    default:
      // Unknown field type — accept any string so the AI can at least
      // try; the application-layer ajv validation will catch mismatches.
      return { type: 'string' };
  }
}

function entryToBlockDef(entry: EmailBlockEntry): AiBlockDefView {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const [propName, fieldConfig] of Object.entries(entry.fields)) {
    const propSchema = fieldToJsonSchemaProp(fieldConfig);
    if (!propSchema) continue;
    properties[propName] = propSchema;
    // Treat any non-slot, non-custom field as required if a default
    // exists for it (the registry's contract says defaultProps cover
    // every required prop).
    if (propName in entry.defaultProps) required.push(propName);
  }
  return {
    id: `registry:${entry.componentId}`,
    key: entry.componentId,
    name: entry.label,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    has_bricks: false,
    theme_kind: 'email',
  };
}

function templateToBlockDef(t: BlockTemplate): AiBlockDefView {
  const schemaRaw = (t.content?.schema ?? {}) as Record<string, unknown>;
  // Mustache templates store JSON Schema directly under `content.schema`.
  // We pass it through unchanged — the server's ajv compiler accepts
  // whatever's there.
  return {
    id: t.id,
    key: t.block_type,
    name: t.name,
    schema: schemaRaw,
    has_bricks: t.content?.has_bricks ?? false,
    theme_kind: 'email',
  };
}

export interface BuildArgs {
  blockTemplates: ReadonlyArray<BlockTemplate>;
  registry: EmailBlockRegistry;
  /**
   * Optional filter — only include registry entries whose componentId
   * appears in this set. Mirrors the same `enabledRegistryComponentIds`
   * filter the editor uses to scope visible blocks per library. When
   * undefined, every registry entry is included.
   */
  enabledRegistryComponentIds?: ReadonlySet<string>;
}

/**
 * Build the merged block-def list. DB templates win on key collision —
 * a Mustache template that intentionally re-uses a registry componentId
 * is the user's explicit override.
 */
export function buildAiBlockDefs(args: BuildArgs): AiBlockDefView[] {
  const out: AiBlockDefView[] = [];
  const seenKeys = new Set<string>();

  for (const t of args.blockTemplates) {
    if (seenKeys.has(t.block_type)) continue;
    out.push(templateToBlockDef(t));
    seenKeys.add(t.block_type);
  }
  for (const entry of args.registry.values()) {
    if (args.enabledRegistryComponentIds && !args.enabledRegistryComponentIds.has(entry.componentId)) continue;
    if (seenKeys.has(entry.componentId)) continue;
    out.push(entryToBlockDef(entry));
    seenKeys.add(entry.componentId);
  }
  return out;
}
