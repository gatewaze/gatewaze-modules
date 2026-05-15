/**
 * 2-column image gallery — two equally-sized images side by side.
 */

import { Column, Img, Row, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface GalleryTwoColProps extends Record<string, unknown> {
  img_1: string;
  img_1_alt: string;
  img_2: string;
  img_2_alt: string;
}

export const GalleryTwoColBlock: EmailBlockEntry<GalleryTwoColProps> = {
  componentId: 'gallery_2_col',
  label: 'Gallery (2 col)',
  category: 'Gallery',
  fields: {
    img_1: { type: 'custom', label: 'Image 1', render: NewsletterImageFieldAdapter as never },
    img_1_alt: { type: 'text', label: 'Image 1 — alt' },
    img_2: { type: 'custom', label: 'Image 2', render: NewsletterImageFieldAdapter as never },
    img_2_alt: { type: 'text', label: 'Image 2 — alt' },
  },
  defaultProps: { img_1: '', img_1_alt: '', img_2: '', img_2_alt: '' },
  Component: ({ img_1, img_1_alt, img_2, img_2_alt }) => (
    <Section style={{ padding: '16px 0' }}>
      <Row>
        <Column style={{ width: '50%', verticalAlign: 'top', paddingRight: 8 }}>
          {img_1 ? <Img src={img_1} alt={img_1_alt} width={280} style={{ display: 'block', width: '100%', maxWidth: '100%', borderRadius: 6 }} /> : null}
        </Column>
        <Column style={{ width: '50%', verticalAlign: 'top', paddingLeft: 8 }}>
          {img_2 ? <Img src={img_2} alt={img_2_alt} width={280} style={{ display: 'block', width: '100%', maxWidth: '100%', borderRadius: 6 }} /> : null}
        </Column>
      </Row>
    </Section>
  ),
};
