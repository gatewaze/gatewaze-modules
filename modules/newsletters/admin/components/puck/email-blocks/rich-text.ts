/**
 * Normalize rich-text (TipTap-authored) HTML for email rendering.
 *
 * The legacy newsletter system inlined email-tight styles on lists and
 * paragraphs at render time; the migrated content only carries the raw
 * editor markup (`<ul><li><p>…</p></li>`, `<p style="text-align: left;">`),
 * so browser/email defaults produce over-indented bullets with large gaps
 * (the `<p>` inside each `<li>` adds default paragraph margins).
 *
 * This injects the original inline styles so rich-text renders the same as
 * the old output:
 *   - unwrap a single `<p>` inside an `<li>` and give the `<li>` margin:0
 *   - `<ul>`/`<ol>` → `margin:8px 0; padding-left:20px`
 *   - bare paragraphs → `margin:0 0 12px 0`
 *
 * Idempotent-ish: elements that already declare a `style` are left alone.
 * Shared across all native react-email blocks that render an HTML field.
 */
export function normalizeRichText(html: unknown): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  return html
    // Unwrap a single <p> directly inside an <li> (TipTap wraps list text
    // in a paragraph, whose default margins create the big vertical gaps).
    .replace(
      /<li>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/li>/gi,
      '<li style="margin:0;padding-left:0">$1</li>',
    )
    // Any remaining style-less <li>.
    .replace(/<li(?![^>]*\sstyle=)>/gi, '<li style="margin:0;padding-left:0">')
    // List containers: tight margins + the original 20px indent.
    .replace(
      /<ul(?![^>]*\sstyle=)>/gi,
      '<ul style="margin:8px 0;padding-left:20px;list-style-type:disc">',
    )
    .replace(
      /<ol(?![^>]*\sstyle=)>/gi,
      '<ol style="margin:8px 0;padding-left:20px;list-style-type:decimal">',
    )
    // Bare paragraphs (TipTap emits `text-align: left;` with no margin).
    .replace(/<p style="text-align:\s*left;?">/gi, '<p style="margin:0 0 12px 0;text-align:left">')
    // Images: constrain to the email column and apply the toolbar's optional
    // alignment (data-align) + width (data-width, % of column). `max-width:100%`
    // caps a wide image to the container even if it carries a larger fixed
    // width; `height:auto` keeps the aspect ratio; a % width is fluid on mobile.
    // We rebuild the style from scratch (dropping the editor-only inline style)
    // so the editor's static `display:block` can't override an aligned image's
    // `inline-block`. Alignment wraps the image in a text-aligned block, which
    // centres/aligns reliably across clients (incl. Outlook, where auto margins
    // on images are ignored).
    .replace(/<img\b([^>]*?)\/?>/gi, (_m, rawAttrs: string) => {
      const align = (rawAttrs.match(/\sdata-align=(["'])(left|center|right)\1/i)?.[2] ?? '').toLowerCase();
      const widthPct = rawAttrs.match(/\sdata-width=(["'])(\d{1,3})\1/i)?.[2] ?? '';
      // No alignment/width set → preserve existing styling, just guarantee the
      // column cap (the long-standing behaviour for pasted/plain images).
      if (!align && !widthPct) {
        return /\sstyle=/i.test(rawAttrs)
          ? `<img${rawAttrs.replace(/(\sstyle=(["']))/i, '$1max-width:100%;height:auto;')}>`
          : `<img${rawAttrs} style="max-width:100%;height:auto">`;
      }
      // Alignment/width set → rebuild the style (dropping the editor's auto-margin
      // version) so it's email-robust: a % width that's fluid on mobile, and
      // alignment via a text-aligned wrapper with an inline-block image (centres
      // reliably incl. Outlook, where auto margins on images are ignored).
      const attrs = rawAttrs.replace(/\sstyle=(["'])[\s\S]*?\1/i, '');
      const style: string[] = [];
      if (widthPct) style.push(`width:${widthPct}%`);
      style.push('max-width:100%', 'height:auto');
      style.push(align ? 'display:inline-block' : 'display:block');
      const img = `<img${attrs} style="${style.join(';')}">`;
      return align ? `<div style="text-align:${align};margin:0 0 12px 0">${img}</div>` : img;
    });
}
