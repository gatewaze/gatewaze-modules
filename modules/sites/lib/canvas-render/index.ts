/**
 * Canonical canvas-render module entry point. Per spec-sites-wysiwyg-builder
 * §5.1.
 *
 * Used by:
 *   - The canvas API route (server-side render for the iframe srcdoc)
 *   - Phase 2: the publish-worker (verification render alongside emit)
 *
 * Pure, deterministic. No fetch / Date.now / Math.random.
 */

export { renderPage } from './render-page.js';
export { renderTemplate, TemplateRenderError } from './mustache-subset.js';
export { lookup, lookupSchema, parsePath } from './jsonpath.js';
export { escapeHtml, escapeAttr } from './escape.js';
export { DOMPURIFY_HTML_CONFIG, DOMPURIFY_TRUSTED_HTML_CONFIG, type Sanitiser } from './sanitise.js';
export type {
  RenderInput,
  RenderResult,
  RenderWarning,
  RenderPageView,
  PageBlockNode,
  PageBrickNode,
  BlockDefView,
  BrickDefView,
  WrapperDefView,
  CanvasOp,
  OpEnvelope,
  ApplyOpsResponse,
} from './types.js';
