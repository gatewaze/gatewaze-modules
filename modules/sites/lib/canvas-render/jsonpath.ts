/**
 * Tiny JSONPath subset used by the canvas template engine.
 *
 * Supported syntax:
 *   - "key"            — top-level property
 *   - "nested.key"     — dot-separated path
 *   - "items[0]"       — bracket index
 *   - "list[0].title"  — combined
 *
 * NOT supported (intentional):
 *   - Wildcards (*, **)
 *   - Filters (?(...))
 *   - Recursive descent (..)
 *   - Negative indices
 *
 * The template-engine's missing-field contract (§4.6) maps a missing path
 * to undefined; the renderer treats undefined as the empty string for
 * `{{value}}` and as falsy for `{{#section}}` / `{{^section}}`.
 */

export type JSONPathSegment = { kind: 'prop'; name: string } | { kind: 'index'; idx: number };

const SEG_RE = /([^.[\]]+)|\[(\d+)\]/g;

export function parsePath(path: string): ReadonlyArray<JSONPathSegment> {
  if (!path) return [];
  const out: JSONPathSegment[] = [];
  SEG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEG_RE.exec(path)) !== null) {
    if (m[1] !== undefined) {
      out.push({ kind: 'prop', name: m[1] });
    } else if (m[2] !== undefined) {
      out.push({ kind: 'index', idx: Number(m[2]) });
    }
  }
  return out;
}

export function lookup(content: unknown, path: string): unknown {
  if (content === null || content === undefined) return undefined;
  const segments = parsePath(path);
  let cursor: unknown = content;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (seg.kind === 'prop') {
      if (typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[seg.name];
    } else {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[seg.idx];
    }
  }
  return cursor;
}

/**
 * Walks JSON Schema along the same path; returns the leaf schema or undefined.
 * Used by ingest validation to confirm a `data-field` path resolves.
 */
export function lookupSchema(schema: unknown, path: string): unknown {
  const segments = parsePath(path);
  let cursor: unknown = schema;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    const c = cursor as Record<string, unknown>;
    if (seg.kind === 'prop') {
      const props = c.properties as Record<string, unknown> | undefined;
      if (!props) return undefined;
      cursor = props[seg.name];
    } else {
      // Schema for arrays: { type: 'array', items: {...} }
      cursor = c.items;
    }
  }
  return cursor;
}
