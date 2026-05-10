/**
 * Two-column features composite — Row of two image+title+body cells.
 *
 * Mirrors the "Some new things" panel in Barebone `welcome.tsx` (two
 * columns, each with a square image, a feature heading, and a couple
 * of sentences). Single composite so the operator types four labels
 * + four images instead of stitching Row + Column + Img + Heading +
 * Text by hand.
 */

import { Column, Heading, Img, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface TwoColumnFeaturesProps extends Record<string, unknown> {
  left_image: string;
  left_title: string;
  left_body: string;
  right_image: string;
  right_title: string;
  right_body: string;
}

export const TwoColumnFeaturesBlock: EmailBlockEntry<TwoColumnFeaturesProps> = {
  componentId: 'two_column_features',
  label: 'Two-column features',
  category: 'Content',
  fields: {
    left_image: { type: 'custom', label: 'Left image', render: NewsletterImageFieldAdapter as never },
    left_title: { type: 'text', label: 'Left title', contentEditable: true },
    left_body: { type: 'textarea', label: 'Left body', contentEditable: true },
    right_image: { type: 'custom', label: 'Right image', render: NewsletterImageFieldAdapter as never },
    right_title: { type: 'text', label: 'Right title', contentEditable: true },
    right_body: { type: 'textarea', label: 'Right body', contentEditable: true },
  },
  defaultProps: {
    left_image: '',
    left_title: 'First feature',
    left_body: 'A concise summary of what makes this feature useful.',
    right_image: '',
    right_title: 'Second feature',
    right_body: 'Another concise summary, balanced visually with the first.',
  },
  Component: ({ left_image, left_title, left_body, right_image, right_title, right_body }) => (
    <Section style={{ padding: '32px', backgroundColor: '#F3F4F6', borderRadius: 10 }}>
      <Row>
        <Column style={{ width: '50%', verticalAlign: 'top', paddingRight: 16 }}>
          {left_image ? (
            <Img
              src={left_image}
              alt=""
              width={260}
              style={{ display: 'block', marginBottom: 16, maxWidth: '100%', height: 'auto', borderRadius: 12 }}
            />
          ) : null}
          <Heading as="h3" style={{ margin: '0 0 8px', fontSize: 16, color: '#14171E' }}>
            {left_title}
          </Heading>
          <Text style={{ margin: 0, fontSize: 16, color: '#43454B', lineHeight: 1.6 }}>{left_body}</Text>
        </Column>
        <Column style={{ width: '50%', verticalAlign: 'top', paddingLeft: 16 }}>
          {right_image ? (
            <Img
              src={right_image}
              alt=""
              width={260}
              style={{ display: 'block', marginBottom: 16, maxWidth: '100%', height: 'auto', borderRadius: 12 }}
            />
          ) : null}
          <Heading as="h3" style={{ margin: '0 0 8px', fontSize: 16, color: '#14171E' }}>
            {right_title}
          </Heading>
          <Text style={{ margin: 0, fontSize: 16, color: '#43454B', lineHeight: 1.6 }}>{right_body}</Text>
        </Column>
      </Row>
    </Section>
  ),
};
