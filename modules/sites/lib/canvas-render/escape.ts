/**
 * HTML / attribute escaping. Per spec-sites-wysiwyg-builder §7.1: every
 * `{{value}}` substitution passes through escapeHtml BEFORE template
 * insertion (defense-in-depth — DOMPurify is a backstop).
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

export function escapeAttr(input: unknown): string {
  return escapeHtml(input);
}
