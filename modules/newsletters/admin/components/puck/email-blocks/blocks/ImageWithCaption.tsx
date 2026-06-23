/**
 * Image with caption — figure block. Centered image with italic
 * caption below. Variant of the bare `Img` primitive that adds the
 * caption layer + sensible defaults for centring.
 */

import { Img, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface ImageWithCaptionProps extends Record<string, unknown> {
  src: string;
  alt: string;
  caption: string;
  width: string;
  align: 'left' | 'center' | 'right';
}

const ALIGN_OPTIONS = [
  { label: 'Left', value: 'left' as const },
  { label: 'Center', value: 'center' as const },
  { label: 'Right', value: 'right' as const },
];

export const ImageWithCaptionBlock: EmailBlockEntry<ImageWithCaptionProps> = {
  componentId: 'image_with_caption',
  label: 'Image with caption',
  category: 'Content',
  fields: {
    src: { type: 'custom', label: 'Image', render: NewsletterImageFieldAdapter as never },
    alt: { type: 'text', label: 'Alt text' },
    caption: { type: 'textarea', label: 'Caption', contentEditable: true },
    width: { type: 'text', label: 'Width (px)' },
    align: { type: 'radio', label: 'Alignment', options: ALIGN_OPTIONS },
  },
  defaultProps: {
    src: '',
    alt: '',
    caption: 'A descriptive caption explaining what this image shows.',
    width: '500',
    align: 'center',
  },
  Component: ({ src, alt, caption, width, align }) => {
    const a = align ?? 'center';
    const margin = a === 'center' ? '0 auto' : a === 'right' ? '0 0 0 auto' : '0';
    return (
      <Section style={{ padding: '24px 0', textAlign: a }}>
        {src ? (
          <Img
            src={src}
            alt={alt}
            width={Number(width) || 500}
            style={{ display: 'block', margin, maxWidth: '100%', borderRadius: 6 }}
          />
        ) : null}
        {caption ? (
          <Text style={{ margin: '12px 0 0', fontSize: 13, fontStyle: 'italic', color: '#6B7280' }}>
            {caption}
          </Text>
        ) : null}
      </Section>
    );
  },
};
