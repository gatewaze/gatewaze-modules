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
}

export const ImageWithCaptionBlock: EmailBlockEntry<ImageWithCaptionProps> = {
  componentId: 'image_with_caption',
  label: 'Image with caption',
  category: 'Content',
  fields: {
    src: { type: 'custom', label: 'Image', render: NewsletterImageFieldAdapter as never },
    alt: { type: 'text', label: 'Alt text' },
    caption: { type: 'textarea', label: 'Caption', contentEditable: true },
    width: { type: 'text', label: 'Width (px)' },
  },
  defaultProps: {
    src: '',
    alt: '',
    caption: 'A descriptive caption explaining what this image shows.',
    width: '500',
  },
  Component: ({ src, alt, caption, width }) => (
    <Section style={{ padding: '24px 0', textAlign: 'center' }}>
      {src ? (
        <Img
          src={src}
          alt={alt}
          width={Number(width) || 500}
          style={{ display: 'block', margin: '0 auto', maxWidth: '100%', borderRadius: 6 }}
        />
      ) : null}
      {caption ? (
        <Text style={{ margin: '12px 0 0', fontSize: 13, fontStyle: 'italic', color: '#6B7280' }}>
          {caption}
        </Text>
      ) : null}
    </Section>
  ),
};
