/**
 * Image primitive — react-email's `Img`. Defaults to a centred,
 * responsive image with explicit `width` and `alt` (Outlook needs the
 * width attribute set to render correctly).
 */

import { Img } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface ImgProps extends Record<string, unknown> {
  src: string;
  alt: string;
  width: string;
  align: 'left' | 'center' | 'right';
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
  Component: ({ src, alt, width, align }) => {
    const w = parseInt(width, 10);
    return (
      <Img
        src={src}
        alt={alt}
        width={Number.isFinite(w) && w > 0 ? w : 600}
        style={{
          display: 'block',
          margin: align === 'center' ? '0 auto' : align === 'right' ? '0 0 0 auto' : '0',
          maxWidth: '100%',
          height: 'auto',
        }}
      />
    );
  },
};
