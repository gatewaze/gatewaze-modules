/**
 * The inline-markup sanitiser research output and research edits share.
 * Its own file, with no imports, so the editor, the portal and the worker can
 * all load it without pulling in the recipe runner.
 */

const INLINE_TAGS = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li']);

/**
 * Reduce a string to text plus a tiny inline allow-list. Tags are rebuilt from
 * their names (no attributes survive); anchors are kept only when
 * `allowAnchors` and only with an https href; every other `<` or `>`,
 * including unclosed tags, comments, CDATA and processing instructions, is
 * escaped so a browser or email client can never parse it as markup.
 */
export function sanitizeInline(input: string, opts: { allowAnchors?: boolean } = {}): string {
  const s = String(input ?? '').slice(0, 20_000)
    // NUL is the placeholder marker below; input must not be able to forge one.
    .replace(/\u0000/g, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<(script|style|iframe|object|embed|form|svg|math|template)(?=[\s>/])[^<>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const keep: string[] = [];
  const marked = s.replace(/<\/?([a-z][a-z0-9]*)(?=[\s>/])([^<>]*)>/gi, (m, tagName: string, attrs: string) => {
    const tag = tagName.toLowerCase();
    const closing = m.startsWith('</');
    if (INLINE_TAGS.has(tag)) { keep.push(closing ? `</${tag}>` : (tag === 'br' ? '<br>' : `<${tag}>`)); return `\u0000${keep.length - 1}\u0000`; }
    if (tag === 'a' && opts.allowAnchors) {
      if (closing) { keep.push('</a>'); return `\u0000${keep.length - 1}\u0000`; }
      const href = /href\s*=\s*["']?(https:\/\/[^"'\s<>]+)/i.exec(attrs)?.[1];
      if (!href) return '';
      keep.push(`<a href="${href.replace(/"/g, '%22')}" rel="noopener nofollow">`);
      return `\u0000${keep.length - 1}\u0000`;
    }
    return ''; // disallowed tag: dropped
  });
  const escaped = marked.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/\u0000(\d+)\u0000/g, (_, i: string) => keep[Number(i)] ?? '');
}
