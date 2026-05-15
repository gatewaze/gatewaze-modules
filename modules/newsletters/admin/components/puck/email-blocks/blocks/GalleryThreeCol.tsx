/**
 * 3-column image gallery — three equally-sized images side by side.
 */

import { Column, Img, Row, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface GalleryThreeColProps extends Record<string, unknown> {
  img_1: string;
  img_2: string;
  img_3: string;
}

export const GalleryThreeColBlock: EmailBlockEntry<GalleryThreeColProps> = {
  componentId: 'gallery_3_col',
  label: 'Gallery (3 col)',
  category: 'Gallery',
  fields: {
    img_1: { type: 'custom', label: 'Image 1', render: NewsletterImageFieldAdapter as never },
    img_2: { type: 'custom', label: 'Image 2', render: NewsletterImageFieldAdapter as never },
    img_3: { type: 'custom', label: 'Image 3', render: NewsletterImageFieldAdapter as never },
  },
  defaultProps: { img_1: '', img_2: '', img_3: '' },
  Component: ({ img_1, img_2, img_3 }) => (
    <Section style={{ padding: '16px 0' }}>
      <Row>
        {[img_1, img_2, img_3].map((src, i) => (
          <Column
            key={`g3-${i}`}
            style={{ width: 'calc(100% / 3)', verticalAlign: 'top', padding: '0 4px' }}
          >
            {src ? <Img src={src} alt="" width={180} style={{ display: 'block', width: '100%', maxWidth: '100%', borderRadius: 6 }} /> : null}
          </Column>
        ))}
      </Row>
    </Section>
  ),
};
