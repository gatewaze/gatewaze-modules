/**
 * 4-column image gallery — four small images, suited for thumbnails
 * or product showcases.
 */

import { Column, Img, Row, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface GalleryFourColProps extends Record<string, unknown> {
  img_1: string;
  img_2: string;
  img_3: string;
  img_4: string;
}

export const GalleryFourColBlock: EmailBlockEntry<GalleryFourColProps> = {
  componentId: 'gallery_4_col',
  label: 'Gallery (4 col)',
  category: 'Gallery',
  fields: {
    img_1: { type: 'custom', label: 'Image 1', render: NewsletterImageFieldAdapter as never },
    img_2: { type: 'custom', label: 'Image 2', render: NewsletterImageFieldAdapter as never },
    img_3: { type: 'custom', label: 'Image 3', render: NewsletterImageFieldAdapter as never },
    img_4: { type: 'custom', label: 'Image 4', render: NewsletterImageFieldAdapter as never },
  },
  defaultProps: { img_1: '', img_2: '', img_3: '', img_4: '' },
  Component: ({ img_1, img_2, img_3, img_4 }) => (
    <Section style={{ padding: '16px 0' }}>
      <Row>
        {[img_1, img_2, img_3, img_4].map((src, i) => (
          <Column key={`g4-${i}`} style={{ width: '25%', verticalAlign: 'top', padding: '0 3px' }}>
            {src ? <Img src={src} alt="" width={130} style={{ display: 'block', width: '100%', maxWidth: '100%', borderRadius: 4 }} /> : null}
          </Column>
        ))}
      </Row>
    </Section>
  ),
};
