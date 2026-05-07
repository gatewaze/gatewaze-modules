/**
 * DOMPurify configurations for canvas content. Per spec-sites-wysiwyg-builder
 * §7.1: three formats, three save-time configs, one document-level backstop.
 *
 * The configs are static, platform-defined constants. They are NOT exposed
 * via any user-configurable setting, env var, or admin UI. Changes ship as
 * code and require platform-version bumps.
 */

export interface DompurifyConfig {
  ALLOWED_TAGS: ReadonlyArray<string>;
  ALLOWED_ATTR: ReadonlyArray<string>;
  ALLOW_DATA_ATTR: boolean;
}

/**
 * Save-time + document-level config for `format: "html"` rich-text fields.
 * Applied to user input on save (block.update_field op) AND as the
 * document-level backstop on the final rendered HTML.
 */
export const DOMPURIFY_HTML_CONFIG: DompurifyConfig = {
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'br', 'em', 'i', 'p', 'span', 'strong', 'u',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'code', 'pre',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
};

/**
 * Save-time config for `format: "trusted-html"` super-admin-only fields.
 * NOT used at document level (which always uses DOMPURIFY_HTML_CONFIG to
 * ensure consistent backstop). The save-time pass on the trusted field
 * preserves iframe/script tags from a strict src-allowlist; the
 * document-level pass strips them — UNLESS the canonical-render stamps
 * them with `data-trusted-html="1"` markers, which the document-level
 * config then preserves via ALLOW_DATA_ATTR + a custom hook (wired in
 * server.ts when DOMPurify is loaded).
 */
export const DOMPURIFY_TRUSTED_HTML_CONFIG: DompurifyConfig = {
  ALLOWED_TAGS: [
    ...DOMPURIFY_HTML_CONFIG.ALLOWED_TAGS,
    'iframe', 'script', 'style',
  ],
  ALLOWED_ATTR: [
    ...DOMPURIFY_HTML_CONFIG.ALLOWED_ATTR,
    'src', 'allow', 'allowfullscreen', 'frameborder', 'sandbox',
  ],
  ALLOW_DATA_ATTR: true,
};

/**
 * Server-side sanitisation entry point. The implementation lives in a
 * separate file (`sanitise-impl.ts`) that imports isomorphic-dompurify;
 * this indirection keeps the canvas-render core pure for golden tests
 * (which don't need a DOM env). Callers in API routes import this module
 * directly; tests mock it.
 */
export interface Sanitiser {
  sanitiseHtml(input: string): string;
  sanitiseTrustedHtml(input: string): string;
  /**
   * Document-level backstop pass on the final rendered HTML produced by
   * canonical-render. Preserves elements stamped with data-trusted-html="1".
   */
  sanitiseDocument(html: string): string;
}
