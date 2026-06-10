/**
 * Strict Mustache subset for block_def HTML templates. Per
 * spec-sites-wysiwyg-builder §4.6.
 *
 * Supported:
 *   {{key}}            — HTML-escaped substitution
 *   {{{key}}}          — raw HTML pass-through (only for format:"html"|"trusted-html")
 *   {{>children}}      — partial; expands to the rendered children HTML
 *                       (the only supported partial)
 *   {{#key}}…{{/key}}  — section: truthy scalar renders body once; an array
 *                       value iterates, rendering the body per item with the
 *                       item merged onto the parent context ({{.}} for scalars)
 *   {{^key}}…{{/key}}  — inverse section
 *
 * NOT supported (validated at ingest, rejected with templates.apply.unsupported_mustache_feature):
 *   - Lambdas / functions
 *   - Custom delimiters {{=…=}}
 *   - Comments {{! … }} (stripped at ingest)
 *
 * Missing-field contract (§4.6):
 *   - {{key}} missing  → empty string
 *   - {{{key}}} missing → empty string
 *   - {{#key}}… missing → renders nothing (falsy)
 */

import { escapeHtml } from './escape.js';
import { lookup } from './jsonpath.js';

export type RenderContext = ReadonlyMap<string, string>;

interface Token {
  kind: 'text' | 'var' | 'raw' | 'partial' | 'section_open' | 'inverse_open' | 'section_close';
  value: string;
  /** char offset for error reporting */
  pos: number;
}

const TOKEN_RE = /\{\{(?:(\{)\s*([^}]+?)\s*\}|([#^/>])\s*([^}]+?)|\s*([^}]+?))\s*\}\}/g;

function tokenize(template: string): Token[] {
  const out: Token[] = [];
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(template)) !== null) {
    if (m.index > lastIndex) {
      out.push({ kind: 'text', value: template.slice(lastIndex, m.index), pos: lastIndex });
    }
    if (m[1] !== undefined) {
      // {{{ raw }}}
      out.push({ kind: 'raw', value: m[2]!, pos: m.index });
    } else if (m[3] !== undefined) {
      const sigil = m[3];
      const name = m[4]!;
      if (sigil === '#') out.push({ kind: 'section_open', value: name, pos: m.index });
      else if (sigil === '^') out.push({ kind: 'inverse_open', value: name, pos: m.index });
      else if (sigil === '/') out.push({ kind: 'section_close', value: name, pos: m.index });
      else if (sigil === '>') out.push({ kind: 'partial', value: name, pos: m.index });
    } else {
      out.push({ kind: 'var', value: m[5]!, pos: m.index });
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < template.length) {
    out.push({ kind: 'text', value: template.slice(lastIndex), pos: lastIndex });
  }
  return out;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export interface RenderOptions {
  /** Per-template-position partial values (e.g. for {{>children}}). */
  partials: ReadonlyMap<string, string>;
  /** Marker tags injected via partial OR raw substitution to preserve them
   *  through the document-level DOMPurify pass for trusted-html fields.
   *  See spec §7.1 — this is the {data-trusted-html=1} pathway. */
  trustedHtmlMarkers?: ReadonlySet<string>;
}

/**
 * Render a template against `content`. Throws TemplateRenderError on
 * unmatched section open/close.
 */
export function renderTemplate(
  template: string,
  content: Record<string, unknown>,
  options: RenderOptions,
): string {
  const tokens = tokenize(template);
  const result = renderTokens(tokens, 0, content, options);
  return result.html;
}

interface RenderResult {
  html: string;
  /** Position after the matching section_close, when invoked from a section. */
  end: number;
}

function renderTokens(
  tokens: ReadonlyArray<Token>,
  start: number,
  content: Record<string, unknown>,
  options: RenderOptions,
  /** Set when called recursively for a section/inverse; stops at the matching close. */
  stopOn?: { name: string; inverse?: false } | { name: string; inverse: true },
): RenderResult {
  let html = '';
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    switch (t.kind) {
      case 'text':
        html += t.value;
        i++;
        break;
      case 'var': {
        const v = lookup(content, t.value);
        html += escapeHtml(v);
        i++;
        break;
      }
      case 'raw': {
        const v = lookup(content, t.value);
        html += v === null || v === undefined ? '' : String(v);
        i++;
        break;
      }
      case 'partial': {
        const v = options.partials.get(t.value);
        html += v ?? '';
        i++;
        break;
      }
      case 'section_open':
      case 'inverse_open': {
        const inverse = t.kind === 'inverse_open';
        const value = lookup(content, t.value);
        // Render once against the current context to locate the matching
        // close (and to reuse the body for the scalar/inverse cases).
        const base = renderTokens(tokens, i + 1, content, options, { name: t.value, inverse });
        if (inverse) {
          if (!isTruthy(value)) html += base.html;
        } else if (Array.isArray(value)) {
          // Array iteration (Mustache semantics): render the body once per
          // item, with the item merged onto the parent context. Object items
          // expose their own keys; scalar items are reachable via {{.}}.
          for (const item of value) {
            const itemCtx =
              item !== null && typeof item === 'object' && !Array.isArray(item)
                ? { ...content, ...(item as Record<string, unknown>) }
                : { ...content, '.': item };
            html += renderTokens(tokens, i + 1, itemCtx, options, { name: t.value }).html;
          }
        } else if (isTruthy(value)) {
          html += base.html;
        }
        i = base.end;
        break;
      }
      case 'section_close':
        if (!stopOn || stopOn.name !== t.value) {
          throw new TemplateRenderError(
            `Unmatched section close: {{/${t.value}}} at offset ${t.pos}`,
            t.pos,
          );
        }
        return { html, end: i + 1 };
    }
  }
  if (stopOn) {
    throw new TemplateRenderError(
      `Unclosed section: {{${stopOn.inverse ? '^' : '#'}${stopOn.name}}} never closed`,
      tokens[start - 1]?.pos ?? 0,
    );
  }
  return { html, end: i };
}

export class TemplateRenderError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = 'TemplateRenderError';
    this.pos = pos;
  }
}
