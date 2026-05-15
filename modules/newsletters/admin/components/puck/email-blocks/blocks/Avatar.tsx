/**
 * Single avatar — circular profile image. Building block for
 * testimonials, author bylines, team intros.
 */

import { Img, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface AvatarProps extends Record<string, unknown> {
  src: string;
  alt: string;
  size: string;
  align: 'left' | 'center' | 'right';
}

export const AvatarBlock: EmailBlockEntry<AvatarProps> = {
  componentId: 'avatar',
  label: 'Avatar',
  category: 'Avatars',
  fields: {
    src: { type: 'custom', label: 'Image', render: NewsletterImageFieldAdapter as never },
    alt: { type: 'text', label: 'Alt text' },
    size: { type: 'text', label: 'Size (px)' },
    align: {
      type: 'select',
      label: 'Alignment',
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Center', value: 'center' },
        { label: 'Right', value: 'right' },
      ],
    },
  },
  defaultProps: { src: '', alt: '', size: '48', align: 'center' },
  Component: ({ src, alt, size, align }) => {
    const px = Number(size) || 48;
    return (
      <Section style={{ padding: '12px 0', textAlign: align }}>
        {src ? <Img src={src} alt={alt} width={px} height={px} style={{ borderRadius: px / 2, display: 'inline-block' }} /> : null}
      </Section>
    );
  },
};
