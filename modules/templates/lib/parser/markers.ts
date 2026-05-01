/**
 * Low-level marker extraction.
 *
 * Each function takes a raw HTML string and returns structured matches
 * with location information (line numbers) for downstream error reporting.
 * No validation happens here — see `parse.ts` for that.
 *
 * Marker grammar (spec §4):
 *   <!-- WRAPPER:key | name=...                                            -->...<!-- /WRAPPER:key -->
 *   <!-- BLOCK:key   | name=... | description=... | has_bricks=... | sort_order=N -->...<!-- /BLOCK:key -->
 *   <!-- BRICK:key   | name=... | sort_order=N                            -->...<!-- /BRICK:key -->
 *   <!-- SCHEMA:{...} -->                              (sibling of preceding BLOCK / BRICK / WRAPPER body)
 *   <!-- DATA_SOURCE:{...} -->                         (sibling of preceding BLOCK body)
 *   <!-- META:key -->...<!-- /META:key -->            (slot inside a WRAPPER)
 *   <!-- RICH_TEXT_TEMPLATE -->\n<!-- ...rich html... -->\n<!-- /RICH_TEXT_TEMPLATE -->
 */

export interface MarkerLocation {
  /** 1-indexed line number where the marker starts. */
  line: number;
  /** 0-indexed character offset in the source. */
  offset: number;
}

export interface KeyValueAttrs {
  [attr: string]: string;
}

export interface OpenTagMatch {
  /** The marker keyword: 'BLOCK' | 'BRICK' | 'WRAPPER' | 'META' | 'SCHEMA' | 'DATA_SOURCE' | 'RICH_TEXT_TEMPLATE' */
  marker: string;
  /** The key after the colon (BLOCK:hero -> 'hero'). Empty for SCHEMA/DATA_SOURCE/RICH_TEXT_TEMPLATE/SPACER which have no key. */
  key: string;
  /** Parsed `key=value | key=value` attributes from the pipe-separated tail. */
  attrs: KeyValueAttrs;
  /** For SCHEMA / DATA_SOURCE: the JSON payload string (raw, unparsed). */
  payload: string | null;
  location: MarkerLocation;
  /** The exact source slice this match represents (for replacement / removal). */
  rawMatch: string;
}

/**
 * Compute (line, offset) from a string and an index. Linear scan; cache
 * if needed by callers issuing many lookups.
 */
export function locationAt(source: string, index: number): MarkerLocation {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line++;
  }
  return { line, offset: index };
}

/**
 * Parse a pipe-separated `key=value | key=value` attribute string into a map.
 * Returns an empty object for blank input.
 */
export function parseAttributes(attrString: string): KeyValueAttrs {
  const out: KeyValueAttrs = {};
  if (!attrString) return out;

  const parts = attrString.split('|').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) continue;
    const key = part.substring(0, eqIndex).trim();
    const value = part.substring(eqIndex + 1).trim();
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Iterate every top-level open tag of a marker family and yield matches.
 *
 * `markerName`: the keyword (e.g. 'BLOCK', 'BRICK', 'WRAPPER').
 * `source`: the full HTML being scanned.
 *
 * For container markers (BLOCK / BRICK / WRAPPER / META) this yields the
 * OPEN tag only; the matching `findClose` helper finds the close tag.
 * Callers iterate open tags, locate the matching close, then recurse into
 * the body.
 */
export function* findOpenTags(markerName: string, source: string): Generator<OpenTagMatch> {
  // Marker name + colon + key + optional pipe-separated attrs
  const re = new RegExp(
    String.raw`<!--\s*${markerName}:(\w+)(?:\s*\|\s*([\s\S]*?))?\s*-->`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const key = m[1] ?? '';
    const attrTail = (m[2] ?? '').trim();
    yield {
      marker: markerName,
      key,
      attrs: parseAttributes(attrTail),
      payload: null,
      location: locationAt(source, m.index),
      rawMatch: m[0],
    };
  }
}

/**
 * Find the end index (exclusive) of the matching close tag for a marker
 * starting at openEndIndex. Returns -1 if no close tag is found.
 *
 * Supports keyed markers (BLOCK:hero -> /BLOCK:hero) and keyless markers
 * (RICH_TEXT_TEMPLATE -> /RICH_TEXT_TEMPLATE).
 */
export function findClose(
  source: string,
  markerName: string,
  key: string,
  searchFromIndex: number,
): { closeStart: number; closeEnd: number } | null {
  const closeMarker = key
    ? `<!--\\s*\\/${markerName}:${escapeRegExp(key)}\\s*-->`
    : `<!--\\s*\\/${markerName}\\s*-->`;
  const re = new RegExp(closeMarker);
  const slice = source.substring(searchFromIndex);
  const m = re.exec(slice);
  if (!m) return null;
  return {
    closeStart: searchFromIndex + m.index,
    closeEnd: searchFromIndex + m.index + m[0].length,
  };
}

/**
 * Extract the FIRST `<!-- SCHEMA:{...} -->` payload from a body slice.
 * Returns the parsed JSON object (or empty object on blank/missing) and
 * the body content with the schema comment removed.
 *
 * Throws on JSON parse failure — callers convert to ParseError with location.
 */
export function extractSchemaPayload(body: string): {
  schema: Record<string, unknown>;
  remaining: string;
  schemaMatchEnd: number;
} {
  const m = body.match(/<!--\s*SCHEMA:([\s\S]*?)-->/);
  if (!m) return { schema: {}, remaining: body, schemaMatchEnd: 0 };

  const matchIndex = m.index ?? 0;
  const matchEnd = matchIndex + m[0].length;
  const jsonStr = (m[1] ?? '').trim();
  let schema: Record<string, unknown> = {};
  if (jsonStr.length > 0 && jsonStr !== '{}') {
    schema = JSON.parse(jsonStr) as Record<string, unknown>;
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      throw new SyntaxError('SCHEMA payload must be a JSON object literal');
    }
  }
  return {
    schema,
    remaining: body.substring(0, matchIndex) + body.substring(matchEnd),
    schemaMatchEnd: matchEnd,
  };
}

/**
 * Extract a `<!-- DATA_SOURCE:{...} -->` payload (optional) from the body.
 * Returns null when absent.
 */
export function extractDataSourcePayload(body: string): {
  dataSource: Record<string, unknown> | null;
  remaining: string;
} {
  const m = body.match(/<!--\s*DATA_SOURCE:([\s\S]*?)-->/);
  if (!m) return { dataSource: null, remaining: body };

  const jsonStr = (m[1] ?? '').trim();
  let dataSource: Record<string, unknown> = {};
  if (jsonStr.length > 0) {
    dataSource = JSON.parse(jsonStr) as Record<string, unknown>;
    if (typeof dataSource !== 'object' || dataSource === null || Array.isArray(dataSource)) {
      throw new SyntaxError('DATA_SOURCE payload must be a JSON object literal');
    }
  }
  const remaining = body.substring(0, m.index ?? 0) + body.substring((m.index ?? 0) + m[0].length);
  return { dataSource, remaining };
}

/**
 * Extract a `<!-- RICH_TEXT_TEMPLATE -->...<!-- /RICH_TEXT_TEMPLATE -->`
 * region. Inner content is conventionally wrapped in an outer HTML comment
 * (`<!--`/`-->`) so the rich-text snippet doesn't render in normal HTML —
 * we strip those wrapping markers when present.
 */
export function extractRichTextTemplate(body: string): {
  richText: string | null;
  remaining: string;
} {
  const m = body.match(
    /<!--\s*RICH_TEXT_TEMPLATE\s*-->([\s\S]*?)<!--\s*\/RICH_TEXT_TEMPLATE\s*-->/,
  );
  if (!m) return { richText: null, remaining: body };

  let inner = (m[1] ?? '').trim();
  // Strip outer HTML-comment wrapping if present
  if (inner.startsWith('<!--')) {
    inner = inner.replace(/^<!--\s*/, '').replace(/\s*-->$/, '').trim();
  }
  const remaining =
    body.substring(0, m.index ?? 0) + body.substring((m.index ?? 0) + m[0].length);
  return { richText: inner.length > 0 ? inner : null, remaining };
}

/**
 * Strip all marker open/close tags from a body, leaving only the content
 * between them. Used after a block has had its inner BRICKs / SCHEMA /
 * DATA_SOURCE / RICH_TEXT_TEMPLATE extracted; the residue is the block's
 * own renderable HTML.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the {{var}} / {{#section}} / {{/section}} / {{^inv}} mustache references
 * from a string. Returns each reference once.
 */
export interface MustacheRef {
  name: string;
  /** 'variable' | 'section' | 'inverted' | 'partial' */
  kind: 'variable' | 'section' | 'inverted' | 'partial' | 'tripleStash';
}

export function extractMustacheRefs(template: string): MustacheRef[] {
  const seen = new Set<string>();
  const out: MustacheRef[] = [];

  // {{{var}}} (triple-stash; raw output) — track separately so the lint
  // can flag it inside disallowed content fields.
  const tripleRe = /\{\{\{\s*([^}]+)\s*\}\}\}/g;
  let tm: RegExpExecArray | null;
  while ((tm = tripleRe.exec(template)) !== null) {
    const raw = (tm[1] ?? '').trim();
    if (raw && !seen.has('{{{' + raw)) {
      seen.add('{{{' + raw);
      out.push({ name: raw, kind: 'tripleStash' });
    }
  }

  // {{>partial}}
  const partialRe = /\{\{\s*>\s*([^}\s]+)\s*\}\}/g;
  let pm: RegExpExecArray | null;
  while ((pm = partialRe.exec(template)) !== null) {
    const name = (pm[1] ?? '').trim();
    if (name && !seen.has('>' + name)) {
      seen.add('>' + name);
      out.push({ name, kind: 'partial' });
    }
  }

  // {{var}} | {{#section}} | {{/section}} | {{^inv}}
  const re = /\{\{\s*([#^/]?)\s*([^}]+?)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    // Skip triple-stash (already handled) — its `{` would be at index after the {{; here we match singles
    if (template.charCodeAt((m.index ?? 0) + 2) === 0x7b /* { */) continue;
    const prefix = m[1] ?? '';
    const name = (m[2] ?? '').trim();
    if (!name) continue;
    if (name.startsWith('!') || prefix === '/') continue;
    if (name.startsWith('>')) continue;
    const key = prefix + name;
    if (seen.has(key)) continue;
    seen.add(key);
    let kind: MustacheRef['kind'] = 'variable';
    if (prefix === '#') kind = 'section';
    else if (prefix === '^') kind = 'inverted';
    out.push({ name, kind });
  }

  return out;
}
