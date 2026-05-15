/**
 * Image primitive — react-email's `Img`. Defaults to a centred,
 * responsive image with explicit `width` and `alt` (Outlook needs the
 * width attribute set to render correctly).
 *
 * Empty-src handling: when no image has been picked yet, we render a
 * placeholder `<div>` in edit mode (so the editor can show "add an
 * image" affordance) and `null` at publish time (no broken <img src="">
 * in the sent email). React-DOM treats `<img src="">` as a request for
 * the current page URL, which dev mode flags as a bug.
 */

import { Img } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface ImgProps extends Record<string, unknown> {
  src: string;
  alt: string;
  width: string;
  align: 'left' | 'center' | 'right';
  editMode?: boolean;
}

const ALIGN_OPTIONS = [
  { label: 'Left', value: 'left' as const },
  { label: 'Center', value: 'center' as const },
  { label: 'Right', value: 'right' as const },
];

export const ImgBlock: EmailBlockEntry<ImgProps> = {
  componentId: 'img',
  label: 'Image',
  category: 'Content',
  fields: {
    src: { type: 'custom', label: 'Image', render: NewsletterImageFieldAdapter as never },
    alt: { type: 'text', label: 'Alt text' },
    width: { type: 'text', label: 'Width (px)' },
    align: { type: 'radio', label: 'Alignment', options: ALIGN_OPTIONS },
  },
  defaultProps: {
    src: '',
    alt: '',
    width: '600',
    align: 'center',
  },
  Component: ({ src, alt, width, align, editMode }) => {
    const w = parseInt(width, 10);
    const resolvedWidth = Number.isFinite(w) && w > 0 ? w : 600;
    const marginStyle =
      align === 'center' ? '0 auto' : align === 'right' ? '0 0 0 auto' : '0';

    // No source picked yet. In edit mode show an inline placeholder so
    // the user sees where the image will land; in publish mode emit
    // nothing rather than a broken <img src="">.
    if (!src) {
      if (!editMode) return null;
      return (
        <div
          aria-label="Image placeholder — pick an image in the fields tab"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: `${resolvedWidth}px`,
            maxWidth: '100%',
            height: Math.round(resolvedWidth * 9 / 16),
            margin: marginStyle,
            background:
              'repeating-linear-gradient(45deg, #f3f4f6 0 8px, #e5e7eb 8px 16px)',
            border: '1px dashed #9ca3af',
            color: '#6b7280',
            fontSize: 12,
            borderRadius: 4,
          }}
        >
          Add an image
        </div>
      );
    }

    return (
      <Img
        src={src}
        alt={alt}
        width={resolvedWidth}
        style={{
          display: 'block',
          margin: marginStyle,
          maxWidth: '100%',
          height: 'auto',
        }}
      />
    );
  },
};
