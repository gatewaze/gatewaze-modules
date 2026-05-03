/**
 * Mustache-1.x-compatible substitution for sites' SSR renderer.
 *
 * The templates module's parser validates that templates only use the
 * subset of mustache we support; this module performs the actual
 * substitution at render time. Supported constructs:
 *
 *   {{var}}              — escaped substitution
 *   {{{var}}}            — raw substitution (HTML-typed fields only;
 *                          enforced by templates lint, not here)
 *   {{#section}}...{{/section}}
 *                        — truthy / iterable section
 *   {{^section}}...{{/section}}
 *                        — inverted (renders only if falsy/empty)
 *   {{>partial}}         — partial reference (looks up from `partials` map)
 *   {{!comment}}         — stripped at render time
 *
 * Keys may be dot-notated to descend into nested objects:
 *   {{seo.title}}, {{author.name}}
 *
 * Whitespace inside delimiters is tolerated. Unknown keys render as the
 * empty string (matches the lint's diagnostic that runtime renders empty).
 */

import { escapeHtml } from './escape.js';

export interface SubstituteOptions {
  /** Partials registry. Lookups are by literal key (no scope walking). */
  partials?: Record<string, string>;
  /** Max recursion depth — partials may reference other partials. */
  maxPartialDepth?: number;
}

export type View = Record<string, unknown>;

interface Frame {
  view: View;
  parent: Frame | null;
}

/**
 * Substitute Mustache tags in `template` against `view`. Returns the
 * rendered string. Throws `Error('mustache_unbalanced_section')` if a
 * section opener has no matching closer (defensive — the lint should
 * already reject this).
 */
export function substitute(template: string, view: View, opts: SubstituteOptions = {}): string {
  const partials = opts.partials ?? {};
  const maxDepth = opts.maxPartialDepth ?? 16;
  const tokens = tokenize(template);
  return renderTokens(tokens, { view, parent: null }, partials, 0, maxDepth);
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

interface TextToken {
  kind: 'text';
  value: string;
}
interface VarToken {
  kind: 'var';
  key: string;
  raw: boolean;       // triple-stash → raw=true
}
interface SectionToken {
  kind: 'section';
  key: string;
  inverted: boolean;
  body: Token[];
}
interface PartialToken {
  kind: 'partial';
  key: string;
}

type Token = TextToken | VarToken | SectionToken | PartialToken;

type FlatToken =
  | TextToken
  | VarToken
  | PartialToken
  | { kind: 'open'; key: string; inverted: boolean }
  | { kind: 'close'; key: string };

// Two-track regex: triple-stash (raw) vs double-stash (with optional sigil).
// Triple-stash MUST be matched first (alternation order matters) so we don't
// accidentally consume `{{` of a `{{{` and leave the third `{` orphaned.
const TAG_RE = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{(#|\^|\/|>|!|&)?\s*([^}]+?)\s*\}\}/g;

function tokenize(template: string): Token[] {
  const flat: FlatToken[] = [];
  let lastIndex = 0;
  for (const match of template.matchAll(TAG_RE)) {
    const fullStart = match.index ?? 0;
    if (fullStart > lastIndex) {
      flat.push({ kind: 'text', value: template.slice(lastIndex, fullStart) });
    }
    const tripleKey = match[1];
    if (tripleKey !== undefined) {
      flat.push({ kind: 'var', key: tripleKey.trim(), raw: true });
      lastIndex = fullStart + match[0].length;
      continue;
    }
    const sigil = match[2] ?? '';
    const keyRaw = (match[3] ?? '').trim();
    if (sigil === '!') {
      // comment — skip
    } else if (sigil === '#') {
      flat.push({ kind: 'open', key: keyRaw, inverted: false });
    } else if (sigil === '^') {
      flat.push({ kind: 'open', key: keyRaw, inverted: true });
    } else if (sigil === '/') {
      flat.push({ kind: 'close', key: keyRaw });
    } else if (sigil === '>') {
      flat.push({ kind: 'partial', key: keyRaw });
    } else {
      // Ampersand-prefix bypasses escaping, same as triple-stash.
      flat.push({ kind: 'var', key: keyRaw, raw: sigil === '&' });
    }
    lastIndex = fullStart + match[0].length;
  }
  if (lastIndex < template.length) {
    flat.push({ kind: 'text', value: template.slice(lastIndex) });
  }
  return nest(flat, null);
}

function nest(flat: FlatToken[], expectedClose: string | null): Token[] {
  const out: Token[] = [];
  while (flat.length > 0) {
    const t = flat.shift()!;
    if (t.kind === 'text' || t.kind === 'var' || t.kind === 'partial') {
      out.push(t);
      continue;
    }
    if (t.kind === 'open') {
      const body = nest(flat, t.key);
      out.push({ kind: 'section', key: t.key, inverted: t.inverted, body });
      continue;
    }
    if (t.kind === 'close') {
      if (t.key === expectedClose) return out;
      throw new Error(`mustache_unbalanced_section: closing /${t.key}, expected /${expectedClose ?? '(end)'}`);
    }
  }
  if (expectedClose !== null) {
    throw new Error(`mustache_unbalanced_section: section ${expectedClose} never closed`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTokens(tokens: Token[], frame: Frame, partials: Record<string, string>, depth: number, maxDepth: number): string {
  let out = '';
  for (const t of tokens) {
    out += renderToken(t, frame, partials, depth, maxDepth);
  }
  return out;
}

function renderToken(t: Token, frame: Frame, partials: Record<string, string>, depth: number, maxDepth: number): string {
  if (t.kind === 'text') return t.value;
  if (t.kind === 'var') {
    const v = lookup(frame, t.key);
    if (v === null || v === undefined) return '';
    if (t.raw) return typeof v === 'string' ? v : String(v);
    return escapeHtml(v);
  }
  if (t.kind === 'partial') {
    if (depth >= maxDepth) return '';
    const partial = partials[t.key];
    if (!partial) return '';
    const partialTokens = tokenize(partial);
    return renderTokens(partialTokens, frame, partials, depth + 1, maxDepth);
  }
  // section
  const v = lookup(frame, t.key);
  if (t.inverted) {
    if (isFalsy(v)) return renderTokens(t.body, frame, partials, depth, maxDepth);
    return '';
  }
  if (isFalsy(v)) return '';
  if (Array.isArray(v)) {
    let s = '';
    for (const item of v) {
      const childView = isViewLike(item) ? (item as View) : { '.': item };
      s += renderTokens(t.body, { view: childView, parent: frame }, partials, depth, maxDepth);
    }
    return s;
  }
  if (isViewLike(v)) {
    return renderTokens(t.body, { view: v as View, parent: frame }, partials, depth, maxDepth);
  }
  // Truthy non-object/array — render body once with current frame.
  return renderTokens(t.body, frame, partials, depth, maxDepth);
}

function lookup(frame: Frame, key: string): unknown {
  if (key === '.') return frame.view['.'] ?? frame.view;
  const parts = key.split('.');
  // Walk frames outward; for each, attempt to descend the dotted path.
  for (let f: Frame | null = frame; f !== null; f = f.parent) {
    let node: unknown = f.view;
    let hit = true;
    for (const p of parts) {
      if (node && typeof node === 'object' && !Array.isArray(node) && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        hit = false;
        break;
      }
    }
    if (hit) return node;
  }
  return null;
}

function isFalsy(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (v === false) return true;
  if (v === 0) return true;
  if (typeof v === 'string' && v.length === 0) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function isViewLike(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
