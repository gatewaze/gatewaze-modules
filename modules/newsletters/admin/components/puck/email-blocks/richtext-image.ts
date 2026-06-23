/**
 * Email-safe Image extension for the newsletter richtext fields.
 *
 * Extends the stock TipTap Image with two persisted attributes the toolbar sets:
 *   - data-align  : 'left' | 'center' | 'right'   (block alignment)
 *   - data-width  : '25' | '50' | '75' | '100'    (width as % of the column)
 *
 * `renderHTML` computes an inline style from them so the change is visible *in
 * the editor* (WYSIWYG) and survives in getHTML() as a plain `style` regardless
 * of how the markup is later processed. The data-* attributes are also emitted
 * so `normalizeRichText` can produce an Outlook-robust wrapper at email-render
 * time (auto margins centre in browsers + most clients but not Outlook).
 *
 * NOTE: changing this extension requires a full page reload of the editor —
 * tiptap builds the document schema once when the editor is created, so an HMR
 * swap leaves a running editor on the old schema and new attributes are ignored.
 */

import Image from '@tiptap/extension-image';

function imageStyle(attrs: Record<string, unknown>): string {
  const parts: string[] = [];
  const w = attrs.dataWidth;
  if (w != null && /^\d{1,3}$/.test(String(w))) parts.push(`width:${w}%`);
  parts.push('max-width:100%', 'height:auto');
  switch (attrs.dataAlign) {
    case 'center': parts.push('display:block', 'margin-left:auto', 'margin-right:auto'); break;
    case 'right': parts.push('display:block', 'margin-left:auto', 'margin-right:0'); break;
    case 'left': parts.push('display:block', 'margin-right:auto', 'margin-left:0'); break;
    default: parts.push('display:block');
  }
  return parts.join(';');
}

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
  renderHTML({ HTMLAttributes, node }) {
    // Merge with a plain spread rather than @tiptap/core's mergeAttributes —
    // the admin Vite build stubs @tiptap/core (the module is only meant to
    // import @tiptap/extension-image). HTMLAttributes already carries src/alt +
    // the rendered data-* attributes; we only need to set the computed style.
    return [
      'img',
      {
        ...(this.options.HTMLAttributes ?? {}),
        ...HTMLAttributes,
        style: imageStyle(node.attrs as Record<string, unknown>),
      },
    ];
  },
}).configure({ inline: false });
