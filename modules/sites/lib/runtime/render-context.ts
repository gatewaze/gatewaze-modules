/**
 * RenderContext canonicalization (spec-sites-theme-kinds §7.6.0).
 *
 *   Canonical form: flat object with dot-notation keys.
 *     { persona: 'developer', 'utm.campaign': 'mcp-security', 'geo.country': 'US' }
 *
 *   Ergonomic form: nested objects (allowed in API request bodies; flattened
 *   immediately on receipt).
 *     { persona: 'developer', utm: { campaign: 'mcp-security' }, geo: { country: 'US' } }
 *
 * The runtime API accepts either form on input but stores and returns only
 * the flat form. Storage MUST be flat — `pages_content_variants.match_context`
 * is rejected at INSERT time if nested, because PG's `jsonb @>` semantics on
 * nested objects are surprising and don't index efficiently with GIN.
 *
 * If a request body contains BOTH nested and flat keys for the same axis
 * (e.g. `geo` nested AND `geo.country` flat), the request is ambiguous and
 * the API returns 400 `ambiguous_render_context`.
 *
 * Pure functions; no IO.
 */

export type RenderContextValue = string | number | boolean | null;
export type RenderContextFlat = Record<string, RenderContextValue>;

/**
 * Canonicalize a context object that may be in flat OR nested form. Returns
 * either { ok: true; canonical } with the flat form, or
 *         { ok: false; reason } when the input is ambiguous / malformed.
 */
export function canonicalizeRenderContext(input: unknown): {
  ok: true;
  canonical: RenderContextFlat;
} | {
  ok: false;
  reason: 'malformed_input' | 'ambiguous_render_context' | 'unsupported_value_type';
  detail?: string;
} {
  if (input === null || input === undefined) {
    return { ok: true, canonical: {} };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'malformed_input', detail: 'context must be an object' };
  }

  const obj = input as Record<string, unknown>;
  const flat: RenderContextFlat = {};
  const seen: Set<string> = new Set();

  for (const [key, value] of Object.entries(obj)) {
    if (key.includes('.')) {
      // Already-flat dot-notation key.
      if (!isScalar(value)) {
        return {
          ok: false,
          reason: 'malformed_input',
          detail: `flat key ${JSON.stringify(key)} must have a scalar value, got ${typeName(value)}`,
        };
      }
      if (seen.has(key)) {
        return { ok: false, reason: 'ambiguous_render_context', detail: `duplicate key ${key}` };
      }
      seen.add(key);
      flat[key] = scalarValue(value);
      continue;
    }

    // Either a scalar (top-level key) or a nested object.
    if (isScalar(value)) {
      if (seen.has(key)) {
        return { ok: false, reason: 'ambiguous_render_context', detail: `duplicate key ${key}` };
      }
      seen.add(key);
      flat[key] = scalarValue(value);
      continue;
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Nested object — flatten one level.
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (!isScalar(subValue)) {
          return {
            ok: false,
            reason: 'unsupported_value_type',
            detail: `${key}.${subKey} must be a scalar value, got ${typeName(subValue)} (nesting beyond one level is not supported)`,
          };
        }
        const flatKey = `${key}.${subKey}`;
        if (seen.has(flatKey)) {
          // Duplicate from a flat sibling — ambiguous.
          return {
            ok: false,
            reason: 'ambiguous_render_context',
            detail: `duplicate key ${flatKey} (also appears flat)`,
          };
        }
        seen.add(flatKey);
        flat[flatKey] = scalarValue(subValue);
      }
      continue;
    }

    return {
      ok: false,
      reason: 'unsupported_value_type',
      detail: `${key} must be a scalar or nested object, got ${typeName(value)}`,
    };
  }

  // Second pass — detect cross-form collisions: did a flat 'geo.country' AND
  // a nested 'geo: { country }' appear in the same input?
  // (The first pass catches duplicates but only against keys it has already
  // processed; a flat key processed before a nested-sibling-of-same-name
  // would collide here.) The single-pass logic above already handles this
  // because seen is checked on every flat-key write.

  return { ok: true, canonical: flat };
}

/**
 * Reject any context that contains nested objects. Used at INSERT time on
 * `pages_content_variants.match_context` (per spec §7.6.0 — storage MUST be
 * flat to keep the GIN index efficient).
 */
export function assertFlatContext(context: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(context)) {
    if (value !== null && typeof value === 'object') {
      throw new Error(
        `match_context must be flat dot-notation; key ${JSON.stringify(key)} has a non-scalar value`,
      );
    }
  }
}

function isScalar(v: unknown): v is RenderContextValue {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function scalarValue(v: unknown): RenderContextValue {
  return v as RenderContextValue;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
