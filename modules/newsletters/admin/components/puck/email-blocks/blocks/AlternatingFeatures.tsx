/**
 * Alternating image/text feature — image on left for one feature,
 * image on right for the next. Magazine-style feature presentation.
 */

import { Column, Img, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface AlternatingFeaturesProps extends Record<string, unknown> {
  image_url: string;
  title: string;
  body: string;
  image_side: 'left' | 'right';
}

export const AlternatingFeaturesBlock: EmailBlockEntry<AlternatingFeaturesProps> = {
  componentId: 'alternating_feature',
  label: 'Feature (image + text)',
  category: 'Features',
  fields: {
    image_url: { type: 'custom', label: 'Image', render: NewsletterImageFieldAdapter as never },
    title: { type: 'text', label: 'Title', contentEditable: true },
    body: { type: 'textarea', label: 'Body', contentEditable: true },
    image_side: {
      type: 'select',
      label: 'Image side',
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Right', value: 'right' },
      ],
    },
  },
  defaultProps: {
    image_url: '',
    title: 'Highlighted feature',
    body: 'A paragraph or two describing the feature in detail, paired with a supporting image.',
    image_side: 'left',
  },
  Component: ({ image_url, title, body, image_side }) => {
    const img = image_url ? (
      <Column style={{ width: 260, verticalAlign: 'middle', padding: '0 16px' }}>
        <Img src={image_url} alt="" width={240} style={{ display: 'block', maxWidth: '100%', borderRadius: 8 }} />
      </Column>
    ) : null;
    const text = (
      <Column style={{ verticalAlign: 'middle', padding: '0 16px' }}>
        <Text style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700, color: '#111827' }}>{title}</Text>
        <Text style={{ margin: 0, fontSize: 15, color: '#4B5563', lineHeight: '1.5' }}>{body}</Text>
      </Column>
    );
    return (
      <Section style={{ padding: '24px 0' }}>
        <Row>
          {image_side === 'left' ? (
            <>
              {img}
              {text}
            </>
          ) : (
            <>
              {text}
              {img}
            </>
          )}
        </Row>
      </Section>
    );
  },
};
