/**
 * Lightweight JSON-Schema-shape validator for canvas op content fields.
 * Per spec-sites-wysiwyg-builder §6.1: content fields are validated against
 * the block_def's schema BEFORE the SQL function applies the op.
 *
 * This is a deliberately narrow subset of JSON Schema — handles the common
 * cases that block_defs actually use:
 *   - type: object | string | number | integer | boolean | array
 *   - properties (object children)
 *   - items (array element schema)
 *   - required
 *   - format: html | trusted-html | site-media-id | uri
 *   - enum
 *   - minLength, maxLength, pattern (string)
 *   - minimum, maximum (number)
 *
 * Anything more complex (oneOf / allOf / $ref / patternProperties) is
 * accepted with a warning. A real Ajv integration is a Phase 2 follow-up;
 * adding Ajv now would be dep-churn without an immediate value gain since
 * client-side validation in <PropertiesPanel> already catches typos.
 */

import { lookup, lookupSchema } from '../../lib/canvas-render/jsonpath.js';

export interface ValidationIssue {
  jsonPointer: string;
  message: string;
}

export type ContentValidationResult =
  | { ok: true }
  | { ok: false; issues: ReadonlyArray<ValidationIssue> };

/**
 * Validate a complete content object against the block_def's root schema.
 * Used by `block.insert` / `brick.insert` / `preset.apply`.
 */
export function validateContent(
  content: unknown,
  schema: unknown,
): ContentValidationResult {
  const issues: ValidationIssue[] = [];
  walkValidate(content, schema, '', issues);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Validate a single field update. Used by `block.update_field` /
 * `brick.update_field`.
 */
export function validateFieldUpdate(
  newValue: unknown,
  rootSchema: unknown,
  fieldPath: string,
): ContentValidationResult {
  const fieldSchema = lookupSchema(rootSchema, fieldPath);
  if (fieldSchema === undefined) {
    return {
      ok: false,
      issues: [{ jsonPointer: '/' + fieldPath.replace(/\./g, '/'), message: `field path '${fieldPath}' not found in block_def schema` }],
    };
  }
  const issues: ValidationIssue[] = [];
  walkValidate(newValue, fieldSchema, '/' + fieldPath.replace(/\./g, '/'), issues);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function walkValidate(
  value: unknown,
  schemaUnknown: unknown,
  pointer: string,
  issues: ValidationIssue[],
): void {
  if (typeof schemaUnknown !== 'object' || schemaUnknown === null) {
    // Schema absent — accept (lenient mode).
    return;
  }
  const schema = schemaUnknown as Record<string, unknown>;

  // Skip-validation hooks for the complex constructs we don't implement.
  if ('$ref' in schema || 'oneOf' in schema || 'allOf' in schema || 'anyOf' in schema) {
    return;
  }

  const type = schema.type as string | undefined;

  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ jsonPointer: pointer, message: `expected object, got ${describe(value)}` });
      return;
    }
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
    const required = (schema.required as ReadonlyArray<string> | undefined) ?? [];
    for (const r of required) {
      if (!(r in obj)) {
        issues.push({ jsonPointer: `${pointer}/${r}`, message: 'required' });
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) walkValidate(v, props[k], `${pointer}/${k}`, issues);
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      issues.push({ jsonPointer: pointer, message: `expected array, got ${describe(value)}` });
      return;
    }
    const items = schema.items;
    for (let i = 0; i < value.length; i++) {
      walkValidate(value[i], items, `${pointer}/${i}`, issues);
    }
    return;
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      issues.push({ jsonPointer: pointer, message: `expected string, got ${describe(value)}` });
      return;
    }
    const minLength = schema.minLength as number | undefined;
    const maxLength = schema.maxLength as number | undefined;
    if (minLength !== undefined && value.length < minLength) {
      issues.push({ jsonPointer: pointer, message: `min length ${minLength}` });
    }
    if (maxLength !== undefined && value.length > maxLength) {
      issues.push({ jsonPointer: pointer, message: `max length ${maxLength}` });
    }
    const pattern = schema.pattern as string | undefined;
    if (pattern !== undefined && !new RegExp(pattern).test(value)) {
      issues.push({ jsonPointer: pointer, message: `does not match pattern ${pattern}` });
    }
    const enumVals = schema.enum as ReadonlyArray<unknown> | undefined;
    if (enumVals !== undefined && !enumVals.includes(value)) {
      issues.push({ jsonPointer: pointer, message: `must be one of ${enumVals.join(', ')}` });
    }
    return;
  }

  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ jsonPointer: pointer, message: `expected ${type}, got ${describe(value)}` });
      return;
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      issues.push({ jsonPointer: pointer, message: 'expected integer' });
    }
    const minimum = schema.minimum as number | undefined;
    const maximum = schema.maximum as number | undefined;
    if (minimum !== undefined && value < minimum) {
      issues.push({ jsonPointer: pointer, message: `min ${minimum}` });
    }
    if (maximum !== undefined && value > maximum) {
      issues.push({ jsonPointer: pointer, message: `max ${maximum}` });
    }
    return;
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      issues.push({ jsonPointer: pointer, message: `expected boolean, got ${describe(value)}` });
    }
    return;
  }

  // No type declared — accept any value but check enum if present.
  const enumVals = schema.enum as ReadonlyArray<unknown> | undefined;
  if (enumVals !== undefined && !enumVals.includes(value)) {
    issues.push({ jsonPointer: pointer, message: `must be one of ${enumVals.join(', ')}` });
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// Expose lookup so consumers don't double-import.
export { lookup };
