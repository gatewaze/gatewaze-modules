/**
 * RichText sanitisation. Pure JS — no React, no admin path aliases —
 * so the test runs in node-only without dragging in the editor bundle.
 *
 * Per spec-builder-evaluation §3.4.3 strict allowlist.
 */

import DOMPurify from 'isomorphic-dompurify';

export const RICHTEXT_ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'a',
  'blockquote', 'pre', 'code',
  'span',
] as const;

export const RICHTEXT_ALLOWED_ATTR = ['href', 'title', 'target', 'rel'] as const;

const URL_SCHEMES_RE = /^(https?:|mailto:|tel:|\/)/i;

/**
 * Sanitise editor HTML. Strict allowlist — no <script>, no <style>,
 * no <iframe>, no on* event handlers, no `javascript:` hrefs,
 * no `data:` URIs.
 *
 * Note on `KEEP_CONTENT`: we keep DOMPurify's default (true) which
 * preserves text inside allowed tags (`<p>Hello</p>` keeps "Hello").
 * Tags that we forbid via FORBID_TAGS are dropped along with their
 * content — DOMPurify treats `script`/`style`/`iframe` etc. specially
 * and removes their inner text. Tags merely *not in* ALLOWED_TAGS
 * (e.g. `<img>` here) lose the wrapper but keep surrounding text,
 * which is the expected behaviour for unsupported but non-dangerous
 * elements.
 */
export function sanitizeRichText(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...RICHTEXT_ALLOWED_TAGS],
    ALLOWED_ATTR: [...RICHTEXT_ALLOWED_ATTR],
    ALLOWED_URI_REGEXP: URL_SCHEMES_RE,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'svg'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  });
}
