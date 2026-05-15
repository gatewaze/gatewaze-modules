/**
 * Testimonial card — quote with avatar + name + role. Single-quote
 * variant suitable for placement between content sections.
 */

import { Column, Img, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface TestimonialCardProps extends Record<string, unknown> {
  quote: string;
  avatar_url: string;
  name: string;
  role: string;
  background: string;
}

export const TestimonialCardBlock: EmailBlockEntry<TestimonialCardProps> = {
  componentId: 'testimonial_card',
  label: 'Testimonial card',
  category: 'Testimonials',
  fields: {
    quote: { type: 'textarea', label: 'Quote', contentEditable: true },
    avatar_url: { type: 'custom', label: 'Avatar', render: NewsletterImageFieldAdapter as never },
    name: { type: 'text', label: 'Name' },
    role: { type: 'text', label: 'Role / company' },
    background: { type: 'text', label: 'Card background' },
  },
  defaultProps: {
    quote: 'A short quote that captures the user\'s experience in one or two sentences.',
    avatar_url: '',
    name: 'Jane Doe',
    role: 'Product Manager, Acme Corp',
    background: '#F9FAFB',
  },
  Component: ({ quote, avatar_url, name, role, background }) => (
    <Section style={{ padding: '28px', backgroundColor: background, borderRadius: 8 }}>
      <Text style={{ margin: '0 0 20px', fontSize: 18, fontStyle: 'italic', color: '#111827', lineHeight: '1.5' }}>
        “{quote}”
      </Text>
      <Row>
        {avatar_url ? (
          <Column style={{ width: 56, verticalAlign: 'middle' }}>
            <Img src={avatar_url} alt="" width={48} style={{ borderRadius: 24 }} />
          </Column>
        ) : null}
        <Column style={{ verticalAlign: 'middle', paddingLeft: avatar_url ? 12 : 0 }}>
          <Text style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>{name}</Text>
          <Text style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>{role}</Text>
        </Column>
      </Row>
    </Section>
  ),
};
