/**
 * Canvas template validator. Per spec-sites-wysiwyg-builder §4.5.
 *
 * Inputs: a block_def's `html` template + `schema` JSON Schema + a list of
 * brick_def keys for the block.
 *
 * Validates:
 *   1. Exactly one element carries `data-block-root`.
 *   2. Every `data-field="<jsonpath>"` resolves against `schema.properties`.
 *   3. Every `data-children="<brick-key>"` matches a brick slot.
 *   4. `data-edit="rich-text"` only on non-void elements with text content
 *      (i.e. not on `<img>`, `<input>`, etc.).
 *   5. Every `data-asset="<jsonpath>"` resolves to a field with
 *      `format: "site-media-id"` (loosely — the field's parent must declare
 *      a `site-media-id` format somewhere in its schema).
 *   6. Every `{{{value}}}` substitution targets a field with
 *      `format: "html"` OR `format: "trusted-html"`.
 *   7. Fields with `format: "trusted-html"` carry `x-edit-role: "super_admin"`.
 *   8. No raw `<script>` tags in the template.
 *
 * Returns `{ valid: true }` on success, otherwise `{ valid: false, errors }`
 * with one entry per discovered issue. The caller writes the result back
 * to `templates_block_defs.canvas_validated` + `canvas_validation_errors`.
 *
 * The validator uses regex-based parsing — no DOM library required, keeps
 * the module zero-dep and runnable from both server and worker contexts.
 * Templates are theme-author code (small, well-formed); the regex approach
 * is sufficient for the attribute scan we need.
 */

import { lookupSchema } from '../canvas-render/jsonpath.js';

export interface ValidateInput {
  /** templates_block_defs.html */
  html: string;
  /** templates_block_defs.schema (a JSON Schema for the content object). */
  schema: Record<string, unknown>;
  /** Keys of all `templates_brick_defs` rows whose `block_def_id` matches
   *  this block_def. Empty array if the block has no bricks. */
  brickDefKeys: ReadonlyArray<string>;
}

export interface ValidationError {
  code:
    | 'canvas.template.no_block_root'
    | 'canvas.template.multiple_block_roots'
    | 'canvas.template.field_path_unresolved'
    | 'canvas.template.children_unknown_brick'
    | 'canvas.template.rich_text_void_element'
    | 'canvas.template.asset_path_unresolved'
    | 'canvas.template.unsafe_substitution'
    | 'canvas.template.trusted_html_missing_role'
    | 'canvas.template.script_tag_forbidden';
  message: string;
  /** Char offset within `html`, when known. */
  pos?: number;
  /** Field path / brick key / element tag — kind-specific detail. */
  detail?: string;
}

export type ValidateResult = { valid: true } | { valid: false; errors: ReadonlyArray<ValidationError> };

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

// Match an opening tag with attributes: <tagname …attrs>
// Captures the tag and the raw attribute blob.
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const SCRIPT_TAG_RE = /<script\b/i;

interface ParsedAttrs {
  field?: string;
  edit?: string;
  children?: string;
  asset?: string;
  blockRoot?: boolean;
}

function parseAttrs(blob: string): ParsedAttrs {
  const out: ParsedAttrs = {};
  // Generic attribute matcher: name="value" or name='value' or bare name
  const re = /([a-zA-Z-]+)(?:=("[^"]*"|'[^']*'|\S+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob)) !== null) {
    const name = m[1].toLowerCase();
    const rawValue = m[2];
    const value = rawValue ? rawValue.replace(/^["']|["']$/g, '') : '';
    if (name === 'data-field') out.field = value;
    else if (name === 'data-edit') out.edit = value;
    else if (name === 'data-children') out.children = value;
    else if (name === 'data-asset') out.asset = value;
    else if (name === 'data-block-root') out.blockRoot = true;
  }
  return out;
}

export function validateCanvasTemplate(input: ValidateInput): ValidateResult {
  const errors: ValidationError[] = [];

  // Rule 8: forbid <script> tags entirely.
  const scriptMatch = SCRIPT_TAG_RE.exec(input.html);
  if (scriptMatch) {
    errors.push({
      code: 'canvas.template.script_tag_forbidden',
      message: '<script> tags are not allowed in block_def templates',
      pos: scriptMatch.index,
    });
  }

  let blockRootCount = 0;
  const brickKeySet = new Set(input.brickDefKeys);

  OPEN_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_TAG_RE.exec(input.html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    const pos = m.index;

    if (attrs.blockRoot) {
      blockRootCount++;
      if (blockRootCount > 1) {
        errors.push({
          code: 'canvas.template.multiple_block_roots',
          message: 'data-block-root must appear on exactly one element',
          pos,
        });
      }
    }

    if (attrs.field !== undefined) {
      const resolved = lookupSchema(input.schema, attrs.field);
      if (resolved === undefined) {
        errors.push({
          code: 'canvas.template.field_path_unresolved',
          message: `data-field='${attrs.field}' does not resolve in block_def.schema`,
          detail: attrs.field,
          pos,
        });
      }
      if (attrs.edit === 'rich-text' && VOID_ELEMENTS.has(tag)) {
        errors.push({
          code: 'canvas.template.rich_text_void_element',
          message: `data-edit='rich-text' is not allowed on void element <${tag}>`,
          detail: tag,
          pos,
        });
      }
    }

    if (attrs.children !== undefined && !brickKeySet.has(attrs.children)) {
      errors.push({
        code: 'canvas.template.children_unknown_brick',
        message: `data-children='${attrs.children}' does not match any brick_def key for this block`,
        detail: attrs.children,
        pos,
      });
    }

    if (attrs.asset !== undefined) {
      const resolved = lookupSchema(input.schema, attrs.asset);
      if (resolved === undefined) {
        errors.push({
          code: 'canvas.template.asset_path_unresolved',
          message: `data-asset='${attrs.asset}' does not resolve in block_def.schema`,
          detail: attrs.asset,
          pos,
        });
      } else if (typeof resolved === 'object' && resolved !== null) {
        const fmt = (resolved as { format?: string }).format;
        if (fmt !== 'site-media-id') {
          errors.push({
            code: 'canvas.template.asset_path_unresolved',
            message: `data-asset='${attrs.asset}' must target a field with format: 'site-media-id' (got format: '${fmt ?? '<unset>'}')`,
            detail: attrs.asset,
            pos,
          });
        }
      }
    }
  }

  if (blockRootCount === 0) {
    errors.push({
      code: 'canvas.template.no_block_root',
      message: 'template must contain exactly one element with data-block-root',
    });
  }

  // Rule 6 + 7: scan {{{value}}} substitutions, validate against schema format.
  const RAW_SUB_RE = /\{\{\{\s*([^}]+?)\s*\}\}\}/g;
  let raw: RegExpExecArray | null;
  while ((raw = RAW_SUB_RE.exec(input.html)) !== null) {
    const path = raw[1].trim();
    const resolved = lookupSchema(input.schema, path);
    if (resolved === undefined) {
      // Already covered by the data-field unresolved rule when the path
      // also has data-field — but raw substitutions can target arbitrary
      // schema paths without a data-field. Still surface the missing path.
      errors.push({
        code: 'canvas.template.field_path_unresolved',
        message: `{{{${path}}}} references a field not declared in block_def.schema`,
        detail: path,
        pos: raw.index,
      });
      continue;
    }
    if (typeof resolved !== 'object' || resolved === null) continue;
    const fmt = (resolved as { format?: string }).format;
    if (fmt !== 'html' && fmt !== 'trusted-html') {
      errors.push({
        code: 'canvas.template.unsafe_substitution',
        message: `{{{${path}}}} requires field format: 'html' or 'trusted-html' (got format: '${fmt ?? '<unset>'}')`,
        detail: path,
        pos: raw.index,
      });
    }
    if (fmt === 'trusted-html') {
      const role = (resolved as { 'x-edit-role'?: string })['x-edit-role'];
      if (role !== 'super_admin') {
        errors.push({
          code: 'canvas.template.trusted_html_missing_role',
          message: `{{{${path}}}} on a trusted-html field requires x-edit-role: 'super_admin'`,
          detail: path,
          pos: raw.index,
        });
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
