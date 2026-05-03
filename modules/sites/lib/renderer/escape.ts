/**
 * HTML escaping for the renderer.
 *
 * Single-stash mustache (`{{var}}`) values are HTML-escaped here.
 * Triple-stash (`{{{var}}}`) bypasses this — but the templates lint already
 * restricts triple-stash to fields whose schema declares `format: "html"`,
 * so the substituted value is expected to be safe (sanitized at write time
 * or trusted source).
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

const HTML_ESCAPE_RE = /[&<>"'`=]/g;

export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) return '';
  const s = typeof input === 'string' ? input : String(input);
  return s.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Escape an attribute value for use in an HTML attribute. Defaults to
 * double-quoted attributes (escapeHtml is sufficient).
 */
export function escapeAttr(input: unknown): string {
  return escapeHtml(input);
}
