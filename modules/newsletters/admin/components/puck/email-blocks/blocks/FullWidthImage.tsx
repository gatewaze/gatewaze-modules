/**
 * Edge-to-edge banner image — fills the email's max-width and breaks
 * out of the standard side padding. Common at the top of product
 * announcements. No caption, no link — pure visual.
 */

import { Img, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface FullWidthImageProps extends Record<string, unknown> {
  src: string;
  alt: string;
  link_url: string;
}

export const FullWidthImageBlock: EmailBlockEntry<FullWidthImageProps> = {
  componentId: 'full_width_image',
  label: 'Full-width image',
  category: 'Content',
  fields: {
    src: { type: 'custom', label: 'Image', render: NewsletterImageFieldAdapter as never },
    alt: { type: 'text', label: 'Alt text' },
    link_url: { type: 'text', label: 'Optional URL (image becomes clickable)' },
  },
  defaultProps: {
    src: '',
    alt: '',
    link_url: '',
  },
  Component: ({ src, alt, link_url }) => {
    if (!src) return <Section style={{ padding: '24px 0' }} />;
    const img = (
      <Img
        src={src}
        alt={alt}
        width={600}
        style={{ display: 'block', width: '100%', maxWidth: '100%', height: 'auto' }}
      />
    );
    return (
      <Section style={{ padding: 0, margin: 0 }}>
        {link_url ? <a href={link_url}>{img}</a> : img}
      </Section>
    );
  },
};
