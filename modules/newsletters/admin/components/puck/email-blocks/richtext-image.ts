/**
 * Email-safe Image extension for the newsletter richtext fields.
 *
 * Extends the stock TipTap Image with two persisted attributes the toolbar sets:
 *   - data-align  : 'left' | 'center' | 'right'   (block alignment)
 *   - data-width  : '25' | '50' | '75' | '100'    (width as % of the column)
 *
 * They round-trip through getHTML()/parseHTML() as `data-*` attributes and are
 * translated into email-safe inline styles at render time by `normalizeRichText`
 * (the canvas preview and the sent email both go through it). Keeping the email
 * styling in one place (the render path) means the stored markup stays semantic
 * and portable, and unstyled images render exactly as before.
 */

import Image from '@tiptap/extension-image';

export const RichtextImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      dataAlign: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-align'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.dataAlign ? { 'data-align': String(attrs.dataAlign) } : {},
      },
      dataWidth: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-width'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.dataWidth ? { 'data-width': String(attrs.dataWidth) } : {},
      },
    };
  },
}).configure({
  inline: false,
  HTMLAttributes: { style: 'max-width:100%;height:auto;display:block;' },
});
