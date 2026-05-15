/**
 * Mosaic gallery — one large featured image with three smaller ones.
 * Magazine layout for visual newsletters.
 */

import { Column, Img, Row, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface GalleryMosaicProps extends Record<string, unknown> {
  hero: string;
  thumb_1: string;
  thumb_2: string;
  thumb_3: string;
}

export const GalleryMosaicBlock: EmailBlockEntry<GalleryMosaicProps> = {
  componentId: 'gallery_mosaic',
  label: 'Gallery (mosaic)',
  category: 'Gallery',
  fields: {
    hero: { type: 'custom', label: 'Featured image', render: NewsletterImageFieldAdapter as never },
    thumb_1: { type: 'custom', label: 'Thumbnail 1', render: NewsletterImageFieldAdapter as never },
    thumb_2: { type: 'custom', label: 'Thumbnail 2', render: NewsletterImageFieldAdapter as never },
    thumb_3: { type: 'custom', label: 'Thumbnail 3', render: NewsletterImageFieldAdapter as never },
  },
  defaultProps: { hero: '', thumb_1: '', thumb_2: '', thumb_3: '' },
  Component: ({ hero, thumb_1, thumb_2, thumb_3 }) => (
    <Section style={{ padding: '16px 0' }}>
      {hero ? (
        <Img
          src={hero}
          alt=""
          width={600}
          style={{ display: 'block', width: '100%', maxWidth: '100%', borderRadius: 6, marginBottom: 8 }}
        />
      ) : null}
      <Row>
        {[thumb_1, thumb_2, thumb_3].map((src, i) => (
          <Column key={`mosaic-${i}`} style={{ width: 'calc(100% / 3)', verticalAlign: 'top', padding: '0 4px' }}>
            {src ? <Img src={src} alt="" width={180} style={{ display: 'block', width: '100%', maxWidth: '100%', borderRadius: 4 }} /> : null}
          </Column>
        ))}
      </Row>
    </Section>
  ),
};
