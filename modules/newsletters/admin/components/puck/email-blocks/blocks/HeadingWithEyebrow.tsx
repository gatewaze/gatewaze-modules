/**
 * Heading composite — small "eyebrow" line above a larger headline +
 * optional subhead. Common section opener in marketing emails. The
 * bare `Heading` primitive covers the single-line case; this is the
 * three-part variant.
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface HeadingWithEyebrowProps extends Record<string, unknown> {
  eyebrow: string;
  heading: string;
  subhead: string;
  align: 'left' | 'center' | 'right';
}

export const HeadingWithEyebrowBlock: EmailBlockEntry<HeadingWithEyebrowProps> = {
  componentId: 'heading_with_eyebrow',
  label: 'Heading with eyebrow',
  category: 'Content',
  fields: {
    eyebrow: { type: 'text', label: 'Eyebrow', contentEditable: true },
    heading: { type: 'text', label: 'Heading', contentEditable: true },
    subhead: { type: 'textarea', label: 'Subhead (optional)', contentEditable: true },
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
  defaultProps: {
    eyebrow: 'NEW THIS WEEK',
    heading: 'A short, attention-grabbing headline',
    subhead: 'A supporting line that explains what readers will find below.',
    align: 'center',
  },
  Component: ({ eyebrow, heading, subhead, align }) => (
    <Section style={{ padding: '32px 0', textAlign: align }}>
      {eyebrow ? (
        <Text style={{ margin: '0 0 12px', fontSize: 12, color: '#2563EB', letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 600 }}>
          {eyebrow}
        </Text>
      ) : null}
      <Text style={{ margin: 0, fontSize: 30, fontWeight: 700, color: '#111827', lineHeight: '1.2' }}>
        {heading}
      </Text>
      {subhead ? (
        <Text style={{ margin: '12px 0 0', fontSize: 16, color: '#6B7280' }}>
          {subhead}
        </Text>
      ) : null}
    </Section>
  ),
};
