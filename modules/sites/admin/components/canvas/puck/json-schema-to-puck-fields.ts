/**
 * Field-type mapping from `templates_block_defs.schema` (JSON-Schema
 * draft 2020-12 with custom `format` strings) to Puck `Field` config.
 *
 * Per spec-builder-evaluation §3.2. Pure data transform — no React
 * imports here so the function can be unit-tested without a DOM.
 *
 * Custom-format fields (`richtext`, `image`, `link`, `color`) are
 * emitted as `{ type: 'custom' }` records carrying a `customFormat`
 * tag; the editor wraps them with the appropriate field component
 * at mount time. We do NOT inline React render functions here for
 * two reasons:
 *
 *   1. Keeping this file pure means tests can run in node-only.
 *   2. The renderer choice is theme-kind-aware (richtext renders
 *      differently in email vs website), so injection happens at
 *      Config-build time, not field-mapping time.
 */

import type { ReactNode } from 'react';

export type CustomFormat = 'richtext' | 'image' | 'link' | 'color';

export interface PuckFieldBase {
  label?: string;
  /**
   * True if the schema property carried `x-gatewaze-personalize: true`.
   * The Config adapter wraps personalizable fields with the inline editor
   * + a "Personalize" button that opens VariantEditor against the
   * currently-selected block instance.
   */
  personalizable?: boolean;
}

export type PuckField =
  | (PuckFieldBase & { type: 'text' })
  | (PuckFieldBase & { type: 'textarea' })
  | (PuckFieldBase & { type: 'number' })
  | (PuckFieldBase & { type: 'select'; options: ReadonlyArray<{ label: string; value: string | number | boolean }> })
  | (PuckFieldBase & { type: 'radio'; options: ReadonlyArray<{ label: string; value: string | number | boolean }> })
  | (PuckFieldBase & { type: 'array'; arrayFields: Record<string, PuckField>; defaultItemProps?: Record<string, unknown> })
  | (PuckFieldBase & { type: 'object'; objectFields: Record<string, PuckField> })
  | (PuckFieldBase & { type: 'custom'; customFormat: CustomFormat; render?: (props: { value: unknown; onChange: (v: unknown) => void }) => ReactNode });

export interface FieldMapWarning {
  fieldPath: string;
  reason: string;
  fallback: 'text';
}

export interface FieldMapResult {
  fields: Record<string, PuckField>;
  warnings: ReadonlyArray<FieldMapWarning>;
}

interface JsonSchemaProperty {
  type?: string;
  format?: string;
  enum?: ReadonlyArray<string | number | boolean>;
  title?: string;
  default?: unknown;
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  'x-gatewaze-personalize'?: boolean;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
}

const CUSTOM_FORMATS: ReadonlySet<CustomFormat> = new Set(['richtext', 'image', 'link', 'color']);

/**
 * Map a single block_def's JSON Schema to a Puck `fields` map.
 * Returns warnings for any unmapped formats (used for the
 * puck-readiness audit).
 */
export function jsonSchemaToPuckFields(schema: unknown): FieldMapResult {
  const warnings: FieldMapWarning[] = [];
  const root = isRecord(schema) ? (schema as JsonSchema) : null;
  if (!root || !root.properties) {
    return { fields: {}, warnings: [] };
  }
  const fields: Record<string, PuckField> = {};
  for (const [key, prop] of Object.entries(root.properties)) {
    fields[key] = mapProperty(key, prop, warnings);
  }
  return { fields, warnings };
}

function mapProperty(
  path: string,
  prop: JsonSchemaProperty,
  warnings: FieldMapWarning[],
): PuckField {
  const label = prop.title;
  const personalizable: true | undefined = prop['x-gatewaze-personalize'] === true ? true : undefined;
  const base: { label: string | undefined; personalizable?: true } = { label, personalizable };

  // enum → select (regardless of base type)
  if (prop.enum && prop.enum.length > 0) {
    return {
      type: 'select',
      ...base,
      options: prop.enum.map((v) => ({ label: String(v), value: v })),
    };
  }

  switch (prop.type) {
    case 'string':
      return mapStringProperty(path, prop, warnings, base);

    case 'number':
    case 'integer':
      return { type: 'number', ...base };

    case 'boolean':
      return {
        type: 'radio',
        ...base,
        options: [
          { label: 'Yes', value: true },
          { label: 'No', value: false },
        ],
      };

    case 'array': {
      const items = prop.items;
      if (items && items.type === 'object' && items.properties) {
        const arrayFields: Record<string, PuckField> = {};
        for (const [k, p] of Object.entries(items.properties)) {
          arrayFields[k] = mapProperty(`${path}[].${k}`, p, warnings);
        }
        return { type: 'array', ...base, arrayFields };
      }
      // Array of scalars (or untyped): fall back to text — Puck v0.20
      // arrays only support arrayFields (object items).
      warnings.push({
        fieldPath: path,
        reason: 'array of non-object items not supported',
        fallback: 'text',
      });
      return { type: 'text', ...base };
    }

    case 'object': {
      if (!prop.properties) {
        return { type: 'text', ...base };
      }
      const objectFields: Record<string, PuckField> = {};
      for (const [k, p] of Object.entries(prop.properties)) {
        objectFields[k] = mapProperty(`${path}.${k}`, p, warnings);
      }
      return { type: 'object', ...base, objectFields };
    }

    default:
      warnings.push({
        fieldPath: path,
        reason: `unknown type: ${String(prop.type)}`,
        fallback: 'text',
      });
      return { type: 'text', ...base };
  }
}

function mapStringProperty(
  path: string,
  prop: JsonSchemaProperty,
  warnings: FieldMapWarning[],
  base: { label: string | undefined; personalizable?: true },
): PuckField {
  const format = prop.format;
  if (!format || format === 'text') {
    return { type: 'text', ...base };
  }
  if (format === 'textarea') {
    return { type: 'textarea', ...base };
  }
  if (CUSTOM_FORMATS.has(format as CustomFormat)) {
    return { type: 'custom', ...base, customFormat: format as CustomFormat };
  }
  warnings.push({
    fieldPath: path,
    reason: `unknown string format: ${format}`,
    fallback: 'text',
  });
  return { type: 'text', ...base };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Extract default values from a JSON Schema's `default` keys at the top
 * level. Used for `defaultProps` on Puck components — Puck wants concrete
 * starting values when the user inserts a fresh block.
 */
export function defaultsFromSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const properties = (schema as JsonSchema).properties;
  if (!properties) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v && 'default' in v && v.default !== undefined) {
      out[k] = v.default;
    }
  }
  return out;
}
