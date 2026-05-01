/**
 * Lint passes that run on parsed block / brick / wrapper bodies.
 *
 *  - lintNoSecretsInHtml(html, locationContext): rejects any `{{secret:KEY}}`
 *    references in body HTML. Per spec §9.8 item 8, secrets are restricted
 *    to DATA_SOURCE adapter contexts ONLY. A site admin could otherwise
 *    embed `<div data-k="{{secret:token}}">` and a Site Editor would
 *    inadvertently exfiltrate the secret by publishing the block.
 *
 *  - lintTripleStashOnlyInHtmlFields(schema, html): rejects `{{{var}}}`
 *    references in fields whose schema does NOT declare format='html'.
 *    Triple-stash emits raw HTML — only HTML-typed fields should use it.
 *
 *  - lintMustacheRefsResolveAgainstSchema(schema, html, runtimeGlobals):
 *    every {{var}} in the body must resolve to either a property in the
 *    schema or a well-known runtime global. Misspelled refs become silent
 *    empty strings at render time without this check.
 */

import { extractMustacheRefs } from './markers.js';

export interface LintIssue {
  code: string;
  message: string;
  /** Marker source text (or a slice of it) where the issue was detected. */
  hint?: string;
}

const SECRET_REF_RE = /\{\{\s*secret:[^}]+\}\}/g;

/**
 * Reject any `{{secret:*}}` reference in body HTML.
 * Returns one issue per occurrence (so the author can see all bad references at once).
 */
export function lintNoSecretsInHtml(html: string): LintIssue[] {
  const issues: LintIssue[] = [];
  let m: RegExpExecArray | null;
  SECRET_REF_RE.lastIndex = 0;
  while ((m = SECRET_REF_RE.exec(html)) !== null) {
    issues.push({
      code: 'templates.lint.secret_in_html',
      message:
        '`{{secret:*}}` placeholders are only allowed in DATA_SOURCE adapter config (URL / headers / body), never in block HTML. Move the secret into a DATA_SOURCE block.',
      hint: m[0],
    });
  }
  return issues;
}

/**
 * Triple-stash `{{{var}}}` emits raw HTML. Only allow it for fields whose
 * schema declares format: 'html'. Without this check, a content field
 * intended for plain text could leak unsanitised HTML.
 */
export function lintTripleStashOnlyInHtmlFields(
  schema: Record<string, unknown>,
  html: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const refs = extractMustacheRefs(html).filter((r) => r.kind === 'tripleStash');
  if (refs.length === 0) return issues;

  const htmlFields = collectHtmlFields(schema);
  for (const ref of refs) {
    if (!htmlFields.has(ref.name)) {
      issues.push({
        code: 'templates.lint.triple_stash_non_html',
        message: `\`{{{${ref.name}}}}\` (raw HTML output) is only allowed for fields whose schema declares format: "html". Use {{${ref.name}}} for HTML-escaped output, or add format: "html" to the field.`,
        hint: '{{{' + ref.name + '}}}',
      });
    }
  }
  return issues;
}

/**
 * Walk an arbitrary JSON Schema and collect all property names whose type
 * is 'string' AND format is 'html'.
 */
function collectHtmlFields(schema: Record<string, unknown>, out: Set<string> = new Set()): Set<string> {
  if (!schema || typeof schema !== 'object') return out;
  const props = schema['properties'];
  if (props && typeof props === 'object') {
    for (const [name, def] of Object.entries(props as Record<string, unknown>)) {
      if (def && typeof def === 'object') {
        const d = def as Record<string, unknown>;
        if (d['type'] === 'string' && d['format'] === 'html') {
          out.add(name);
        }
        // Recurse into nested objects / array items
        if (d['type'] === 'object') collectHtmlFields(d, out);
        const items = d['items'];
        if (items && typeof items === 'object' && !Array.isArray(items)) {
          collectHtmlFields(items as Record<string, unknown>, out);
        }
      }
    }
  }
  return out;
}

const RUNTIME_GLOBALS = new Set([
  // Site context
  'site.lang', 'site.name', 'site.css_url', 'site.analytics_id',
  // Page context
  'page.title', 'page.description', 'page.og_image',
  // Edition context (newsletters)
  'edition_date', 'edition.title', 'edition.subject',
  // Viewer context
  'viewer.id', 'viewer.email', 'viewer.first_name', 'viewer.last_name',
  // Special render markers
  'content', 'bricks', '@index', '.', 'isLast',
  // Newsletter built-ins (preserved from existing pipeline)
  'preheader', 'shop_link', 'subscribe_link',
  // Template-source-specific that the host substitutes:
  'view_in_browser_url',
]);

/**
 * Verify every {{var}} / {{#section}} / {{^inv}} reference in the body
 * resolves either against a top-level schema property OR against the
 * known runtime globals. Misspelled refs render as empty strings at
 * runtime, which is hard to debug; flagging them at parse time is cheap.
 */
export function lintMustacheRefsResolveAgainstSchema(
  schema: Record<string, unknown>,
  html: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const props = (schema['properties'] as Record<string, unknown> | undefined) ?? {};
  const propNames = new Set(Object.keys(props));

  // Schema may also declare nested array-of-object schemas whose properties
  // become the loop variables inside {{#arrayName}}...{{/arrayName}}. To
  // verify those we'd need to track the section stack — out of scope for
  // the v0.1 lint (the section-walker pass would be its own helper). For now,
  // we accept any reference inside a {{#section}}...{{/section}} pair as
  // possibly resolved by the section.
  const refs = extractMustacheRefs(html);

  // Build a set of "section-introduced names" — anything inside a #section
  // is forgiven against schema misspellings because we don't fully resolve
  // nested array contexts in v0.1.
  const sectionNames = new Set<string>(refs.filter((r) => r.kind === 'section').map((r) => r.name));

  for (const ref of refs) {
    if (ref.kind === 'partial' || ref.kind === 'tripleStash') continue;
    const root = ref.name.split('.')[0]?.split('|')[0]?.trim() ?? '';
    if (!root) continue;
    if (propNames.has(root)) continue;
    if (sectionNames.has(root)) continue;
    if (RUNTIME_GLOBALS.has(ref.name) || RUNTIME_GLOBALS.has(root)) continue;
    if (root.startsWith('secret:')) continue; // secret refs handled by lintNoSecretsInHtml
    issues.push({
      code: 'templates.lint.unknown_mustache_ref',
      message: `\`{{${ref.name}}}\` does not resolve to a schema property or known runtime global. Check for typos.`,
      hint: '{{' + ref.name + '}}',
    });
  }
  return issues;
}
