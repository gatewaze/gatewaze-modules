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
    // Constrain inline images to the email column. A wide image (e.g. a chart
    // pasted into the body) otherwise renders at its natural width and
    // stretches its card past the others. `max-width:100%` caps it to the
    // container even if the image carries a larger fixed width/attribute;
    // `height:auto` keeps the aspect ratio.
    .replace(/<img\b([^>]*?)\/?>/gi, (_m, attrs: string) =>
      /\sstyle=/i.test(attrs)
        ? `<img${attrs.replace(/(\sstyle=(["']))/i, '$1max-width:100%;height:auto;')}>`
        : `<img${attrs} style="max-width:100%;height:auto">`,
    );
}
