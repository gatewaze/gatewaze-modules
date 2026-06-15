/**
 * Coerce a stored block "schema" into valid JSON Schema (draft 2020-12).
 *
 * Block defs reach the copilot under `schema` in two different encodings:
 *
 *   1. The react-email registry path (newsletters' build-ai-block-defs.ts)
 *      already converts Puck `Field`s into JSON Schema, so those defs
 *      arrive valid.
 *   2. DB-backed mustache templates (`templates_block_defs`) store the
 *      *Puck field map* verbatim — e.g.
 *      `{ text: { type: 'richtext', label: 'Text' }, image_url: { type: 'image' } }`.
 *      That is NOT JSON Schema: `richtext`/`image`/`text` are not valid
 *      `type` values, and there's no object/properties wrapper.
 *
 * Anthropic validates tool `input_schema` strictly against draft 2020-12
 * and rejects the entire tool when it finds an invalid `type` anywhere —
 * even nested under an unknown keyword. That is what broke the newsletter
 * copilot once the MLOps templates (which use the field-map encoding) were
 * imported. ajv would likewise mis-handle the field-map form (no real
 * properties → no real validation).
 *
 * This pure function normalises either encoding into a valid object schema
 * so the same value can feed both the tool-schema builder and the ajv
 * output-validator. It is idempotent: already-valid schemas pass through
 * structurally unchanged.
 */

const VALID_JSON_TYPES = new Set([
  'string', 'number', 'integer', 'boolean', 'object', 'array', 'null',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Map a Puck/legacy field `type` onto a JSON Schema primitive type. */
function jsonTypeForFieldType(t: string | undefined): string {
  switch (t) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return 'array';
    case 'object': return 'object';
    // text, textarea, richtext, image, select, radio, custom, link,
    // email, url, date, … all serialise as strings.
    default: return 'string';
  }
}

/** Preserve the `format` hints the output-validator keys off of (§3.5). */
function formatForFieldType(t: string | undefined): string | undefined {
  switch (t) {
    case 'richtext': return 'richtext';
    case 'image': return 'image';
    case 'link': return 'link';
    default: return undefined;
  }
}

/**
 * Convert one node — which may be a Puck field config OR a JSON Schema
 * subschema — into a valid JSON Schema subschema. Returns null only for
 * `slot` fields: children are user-controlled drag-and-drop content, never
 * AI-generated, so they're omitted from the schema entirely.
 */
function coerceNode(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node)) return {}; // unconstrained — accept anything
  const n = { ...node };
  delete n.$schema;
  delete n.$id;

  const rawType = typeof n.type === 'string' ? n.type : undefined;

  // Puck-only keys. A node carrying any of these is a field config, even
  // when its `type` collides with a JSON type — e.g. a Puck `array` field
  // shapes its items via `fields`, not `items`.
  const hasPuckMarker =
    'fields' in n || 'objectFields' in n || 'arrayFields' in n ||
    'options' in n || 'label' in n;

  const isFieldConfig =
    rawType !== undefined && (!VALID_JSON_TYPES.has(rawType) || hasPuckMarker);

  if (isFieldConfig) {
    if (rawType === 'slot') return null;
    return fieldConfigToProp(n, rawType!);
  }

  const looksLikeSchema =
    (rawType !== undefined && VALID_JSON_TYPES.has(rawType)) ||
    isRecord(n.properties) ||
    typeof n.$ref === 'string' ||
    Array.isArray(n.oneOf) || Array.isArray(n.anyOf) || Array.isArray(n.allOf) ||
    n.enum !== undefined || n.const !== undefined;

  if (looksLikeSchema) return sanitizeSchemaNode(n);

  // No `type` and no schema markers. If every value looks like a field
  // config, treat the whole node as a field map → object schema.
  const values = Object.values(n);
  if (values.length > 0 && values.every((v) => isRecord(v))) {
    return fieldMapToObjectSchema(n);
  }
  return { type: 'object', additionalProperties: false, properties: {} };
}

function fieldConfigToProp(field: Record<string, unknown>, rawType: string): Record<string, unknown> {
  if (rawType === 'array') {
    const itemFields =
      (isRecord(field.fields) ? field.fields : null) ??
      (isRecord(field.arrayFields) ? field.arrayFields : null);
    return {
      type: 'array',
      items: itemFields ? fieldMapToObjectSchema(itemFields) : {},
    };
  }
  if (rawType === 'object') {
    const objFields =
      (isRecord(field.objectFields) ? field.objectFields : null) ??
      (isRecord(field.properties) ? field.properties : null) ??
      (isRecord(field.fields) ? field.fields : null);
    return objFields
      ? fieldMapToObjectSchema(objFields)
      : { type: 'object', additionalProperties: false, properties: {} };
  }
  const prop: Record<string, unknown> = { type: jsonTypeForFieldType(rawType) };
  const fmt = formatForFieldType(rawType);
  if (fmt) prop.format = fmt;
  if (Array.isArray(field.options)) {
    const vals = (field.options as unknown[])
      .map((o) => (isRecord(o) && typeof o.value === 'string' ? o.value : null))
      .filter((v): v is string => v !== null);
    if (vals.length > 0) prop.enum = vals;
  }
  return prop;
}

function fieldMapToObjectSchema(map: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    const prop = coerceNode(v);
    if (prop !== null) properties[k] = prop;
  }
  return { type: 'object', additionalProperties: false, properties };
}

/**
 * Recurse a JSON-Schema-shaped node, fixing any invalid `type` and
 * coercing nested property/item subschemas (which may themselves be field
 * configs in mixed-encoding templates).
 */
function sanitizeSchemaNode(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };

  if (typeof out.type === 'string' && !VALID_JSON_TYPES.has(out.type)) {
    const fmt = formatForFieldType(out.type);
    out.type = jsonTypeForFieldType(out.type);
    if (fmt && out.format === undefined) out.format = fmt;
  }

  if (isRecord(out.properties)) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.properties)) {
      const coerced = coerceNode(v);
      if (coerced !== null) props[k] = coerced;
    }
    out.properties = props;
  }

  if (isRecord(out.items)) {
    const coerced = coerceNode(out.items);
    out.items = coerced ?? {};
  } else if (Array.isArray(out.items)) {
    out.items = out.items.map((it) => coerceNode(it) ?? {});
  }

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map((s) => sanitizeSchemaNode(isRecord(s) ? s : {}));
    }
  }

  // Normalise draft-07 `definitions` → 2020-12 `$defs`, recursing into each.
  for (const key of ['$defs', 'definitions'] as const) {
    if (isRecord(out[key])) {
      const defs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(out[key] as Record<string, unknown>)) {
        defs[k] = coerceNode(v) ?? {};
      }
      out[key] = defs;
    }
  }

  return out;
}

export function coerceBlockSchema(raw: unknown): Record<string, unknown> {
  const coerced = coerceNode(raw);
  if (coerced === null) {
    return { type: 'object', additionalProperties: false, properties: {} };
  }
  // A block's props schema must be an object schema. If coercion produced
  // something without an explicit object shape, give it one.
  if (coerced.type === undefined && !isRecord(coerced.properties)) {
    return { type: 'object', additionalProperties: false, properties: {}, ...coerced };
  }
  return coerced;
}
