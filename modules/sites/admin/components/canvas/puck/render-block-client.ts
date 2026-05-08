/**
 * Client-side single-block renderer used by the Puck render host. Per
 * spec-builder-evaluation §3.5.
 *
 * The legacy editor renders the FULL page via the server-side
 * /canvas/render endpoint and stuffs the HTML into the iframe srcdoc.
 * Puck's iframe model is per-block — Puck calls each component's
 * `render(props)` and composites the results. We need to produce real
 * block HTML inside that render call.
 *
 * `renderTemplate` from canvas-render is a pure JS Mustache subset that
 * works in the browser too — same code path, same escape rules, same
 * missing-field contract as the server-side renderer. We wrap it in a
 * thin facade that:
 *
 *   1. Resolves the block_def's `html` template + schema from a cached
 *      library snapshot (the same one PuckConfigAdapter built from).
 *   2. Calls renderTemplate with the block's content.
 *   3. Returns the result as a string for `dangerouslySetInnerHTML`.
 *
 * Phase B+ goal: feature parity with the legacy iframe for the standard
 * block library. A future Phase C iteration may switch to a per-block
 * server fetch if any block_def template needs a server-only feature
 * (e.g. signed-asset URLs that require RLS).
 */

import { renderTemplate } from '../../../../lib/canvas-render/mustache-subset.js';

export interface BlockTemplateLookup {
  /** key → block_def html (Mustache template). */
  byKey: ReadonlyMap<string, { html: string; schema: Record<string, unknown> }>;
}

export interface RenderBlockArgs {
  blockDefKey: string;
  content: Record<string, unknown>;
  /** Variant key — currently passthrough; variants are server-resolved on save. */
  variantKey: string;
  lookup: BlockTemplateLookup;
}

export interface RenderBlockResult {
  html: string;
  warnings: ReadonlyArray<string>;
}

export function renderBlockClient(args: RenderBlockArgs): RenderBlockResult {
  const tmpl = args.lookup.byKey.get(args.blockDefKey);
  if (!tmpl) {
    return {
      html: `<div class="puck-block-missing" data-block-key="${escapeAttr(args.blockDefKey)}">
        Missing block_def template: ${escapeText(args.blockDefKey)}
      </div>`,
      warnings: [`block_def template not found for key '${args.blockDefKey}'`],
    };
  }

  // renderTemplate accepts the raw content record and applies HTML
  // escape on {{key}} substitutions. {{{key}}} is pass-through; missing
  // fields render as empty string per the canvas-render contract.
  try {
    const html = renderTemplate(tmpl.html, args.content, { partials: new Map<string, string>() });
    return { html, warnings: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      html: `<div class="puck-block-render-error" data-block-key="${escapeAttr(args.blockDefKey)}">
        Render error: ${escapeText(msg)}
      </div>`,
      warnings: [msg],
    };
  }
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? c));
}
