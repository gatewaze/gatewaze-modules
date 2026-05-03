/**
 * JSON-Schema walk + default-value derivation for the schema-driven editor.
 *
 * The editor receives a templates_content_schemas row's `schema_json` and a
 * page's `content` (or null for fresh pages) and renders form fields per
 * the schema. These helpers perform the schema-side bookkeeping:
 *
 *   - Iterating fields with their JSON Pointers
 *   - Determining each field's editor "kind": text / textarea / html /
 *     media-url / number / boolean / object / array / select
 *   - Producing a default-value scaffold from a schema (used when a page
 *     lacks a value at a given path)
 *
 * Pure, no React.
 */

export type FieldEditorKind =
  | 'text'
  | 'textarea'
  | 'html'
  | 'media-url'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'select'
  | 'object'
  | 'array'
  | 'unknown';

export interface SchemaNode {
  type?: string | string[];
  format?: string;
  enum?: ReadonlyArray<unknown>;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: ReadonlyArray<string>;
  default?: unknown;
  title?: string;
  description?: string;
  [k: string]: unknown;          // keep open for x-* extensions
}

export interface FieldDescriptor {
  /** JSON Pointer relative to the root of `content`. */
  pointer: string;
  /** Schema node at this field. */
  schema: SchemaNode;
  /** Editor field kind. */
  kind: FieldEditorKind;
  /** True if the field opts into per-context personalization. */
  personalizable: boolean;
  /** Human-friendly label (schema.title || last pointer segment). */
  label: string;
  /** Required on its parent object? */
  required: boolean;
}

const PERSONALIZE_KEY = 'x-gatewaze-personalize';

/**
 * Resolve a schema node to its editor kind. Honors `format`, `enum`,
 * and the JSON Schema `type`.
 */
export function classifyEditorKind(node: SchemaNode): FieldEditorKind {
  if (Array.isArray(node.enum) && node.enum.length > 0) return 'select';
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  if (t === 'string') {
    if (node.format === 'html') return 'html';
    if (node.format === 'media-url') return 'media-url';
    if (typeof node['maxLength'] === 'number' && (node['maxLength'] as number) > 200) return 'textarea';
    return 'text';
  }
  if (t === 'integer') return 'integer';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return 'object';
  if (t === 'array') return 'array';
  return 'unknown';
}

/**
 * Walk a schema and emit a flat list of FieldDescriptors. Object fields
 * recurse into their `properties`; arrays do NOT recurse (the array
 * editor renders nested items at runtime against the items schema).
 */
export function walkFields(root: SchemaNode, basePointer = ''): FieldDescriptor[] {
  const out: FieldDescriptor[] = [];
  visit(root, basePointer, false, out);
  return out;
}

function visit(node: SchemaNode, pointer: string, requiredHere: boolean, out: FieldDescriptor[]): void {
  const kind = classifyEditorKind(node);
  const personalizable = node[PERSONALIZE_KEY] === true;
  out.push({
    pointer,
    schema: node,
    kind,
    personalizable,
    label: typeof node.title === 'string' ? node.title : labelFromPointer(pointer),
    required: requiredHere,
  });
  if (kind === 'object' && node.properties) {
    const required = new Set(node.required ?? []);
    for (const [key, child] of Object.entries(node.properties)) {
      visit(child, `${pointer}/${escapePointer(key)}`, required.has(key), out);
    }
  }
}

function labelFromPointer(pointer: string): string {
  if (pointer === '') return '(root)';
  const parts = pointer.split('/').filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? pointer;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Build a default-value document from a schema. Honors `default` properties
 * at any depth; falls back to type-appropriate empties (`""`, `0`, `false`,
 * `[]`, `{}`).
 */
export function buildDefault(node: SchemaNode): unknown {
  if (node.default !== undefined) return cloneJson(node.default);
  const kind = classifyEditorKind(node);
  if (kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(node.properties ?? {})) {
      out[k] = buildDefault(child);
    }
    return out;
  }
  if (kind === 'array') return [];
  if (kind === 'boolean') return false;
  if (kind === 'integer' || kind === 'number') return 0;
  return ''; // text, textarea, html, media-url, select, unknown
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// JSON Pointer get/set on a content document
// ---------------------------------------------------------------------------

export function getAtPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  const parts = pointer.split('/').slice(1).map(unescapePointer);
  let node: unknown = doc;
  for (const p of parts) {
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      const idx = Number.parseInt(p, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return undefined;
      node = node[idx];
    } else {
      node = (node as Record<string, unknown>)[p];
    }
  }
  return node;
}

/**
 * Immutable update at a JSON Pointer. Returns a new doc; original is
 * untouched. Creates intermediate objects/arrays if missing (using the
 * schema-derived defaults as guidance is the caller's responsibility).
 */
export function setAtPointer<T>(doc: T, pointer: string, value: unknown): T {
  if (pointer === '') return value as T;
  const parts = pointer.split('/').slice(1).map(unescapePointer);
  return setRec(doc, parts, value) as T;
}

function setRec(node: unknown, parts: string[], value: unknown): unknown {
  if (parts.length === 0) return value;
  const [head, ...rest] = parts;
  if (head === undefined) return value;
  if (Array.isArray(node)) {
    const idx = Number.parseInt(head, 10);
    if (!Number.isInteger(idx) || idx < 0) return node;
    const copy = [...node];
    copy[idx] = setRec(copy[idx], rest, value);
    return copy;
  }
  const base = (node && typeof node === 'object' ? (node as Record<string, unknown>) : {});
  return { ...base, [head]: setRec(base[head], rest, value) };
}

function unescapePointer(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}
