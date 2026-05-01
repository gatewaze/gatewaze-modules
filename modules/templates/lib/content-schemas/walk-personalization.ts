/**
 * walkPersonalizationAxes(schema) — extract per-field-path the
 * `x-gatewaze-personalize` axes declared in the JSON Schema.
 *
 * Returns a Map<jsonPointer, axes[]> for every field that declares
 * personalization. Used by:
 *   - the runtime content API to compute the `appliedContext` and `Vary`
 *     headers (per spec §7.5).
 *   - the editor UI to surface "this field is persona-personalized" badges.
 *
 * Pure function. No DB / network IO.
 */

export interface FieldPersonalization {
  /** JSON Pointer into the schema's content shape (e.g. '/hero/title'). */
  fieldPointer: string;
  /** Axes that may affect this field's value (e.g. ['persona', 'utm.campaign']). */
  axes: string[];
}

export function walkPersonalizationAxes(schema: Record<string, unknown>): FieldPersonalization[] {
  const out: FieldPersonalization[] = [];
  walk(schema, '', out);
  return out;
}

function walk(node: unknown, pointer: string, out: FieldPersonalization[]): void {
  if (!isPlainObject(node)) return;
  const n = node as Record<string, unknown>;

  // Read x-gatewaze-personalize from the current node (the field's own schema).
  const axes = n['x-gatewaze-personalize'];
  if (Array.isArray(axes) && axes.length > 0) {
    out.push({
      fieldPointer: pointer || '/',
      axes: axes.filter((a): a is string => typeof a === 'string'),
    });
  }

  const props = n['properties'];
  if (isPlainObject(props)) {
    for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
      walk(sub, pointer + '/' + escapePointer(key), out);
    }
  }

  const items = n['items'];
  if (isPlainObject(items)) {
    walk(items, pointer + '/items', out);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function escapePointer(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Resolve a request's RenderContext to the subset of axes that ACTUALLY
 * affected the rendered content for a given field. Used to build the
 * `appliedContext` field in the runtime API response.
 *
 * Given:
 *   - axes: the schema-declared axes for this field (e.g. ['persona', 'utm.campaign'])
 *   - context: the canonical flat-form RenderContext from the request
 *   - matchedVariantContext: the variant.match_context that was selected (or null
 *     if base content was used)
 *
 * Returns: the subset of `axes` whose values were both (a) present in the
 * matched variant's match_context AND (b) present in the request's context.
 * Empty when base content was served (no variant matched).
 */
export function appliedAxesForField(
  axes: string[],
  context: Record<string, unknown>,
  matchedVariantContext: Record<string, unknown> | null,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!matchedVariantContext) return out;
  for (const axis of axes) {
    if (axis in matchedVariantContext && axis in context) {
      const v = context[axis];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[axis] = v;
      }
    }
  }
  return out;
}
