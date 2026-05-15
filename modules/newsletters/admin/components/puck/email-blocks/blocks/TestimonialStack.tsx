/**
 * Stacked testimonials — three minimal quote rows. Companion to the
 * single TestimonialCard for social-proof sections at the end of
 * newsletters.
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface TestimonialStackProps extends Record<string, unknown> {
  heading: string;
  q1_quote: string;
  q1_attribution: string;
  q2_quote: string;
  q2_attribution: string;
  q3_quote: string;
  q3_attribution: string;
}

function Quote({ quote, attribution }: { quote: string; attribution: string }) {
  if (!quote) return null;
  return (
    <div style={{ padding: '16px 0' }}>
      <Text style={{ margin: '0 0 6px', fontSize: 15, color: '#111827', lineHeight: '1.5' }}>“{quote}”</Text>
      <Text style={{ margin: 0, fontSize: 12, color: '#6B7280' }}>— {attribution}</Text>
    </div>
  );
}

export const TestimonialStackBlock: EmailBlockEntry<TestimonialStackProps> = {
  componentId: 'testimonial_stack',
  label: 'Testimonial stack',
  category: 'Testimonials',
  fields: {
    heading: { type: 'text', label: 'Section heading' },
    q1_quote: { type: 'textarea', label: 'Quote 1' },
    q1_attribution: { type: 'text', label: 'Quote 1 — attribution' },
    q2_quote: { type: 'textarea', label: 'Quote 2' },
    q2_attribution: { type: 'text', label: 'Quote 2 — attribution' },
    q3_quote: { type: 'textarea', label: 'Quote 3' },
    q3_attribution: { type: 'text', label: 'Quote 3 — attribution' },
  },
  defaultProps: {
    heading: 'What customers say',
    q1_quote: 'This tool changed the way our team ships.',
    q1_attribution: 'Alex, CTO',
    q2_quote: 'We saved hours every week from week one.',
    q2_attribution: 'Sam, Engineering Manager',
    q3_quote: 'Setup was painless and the team loved it instantly.',
    q3_attribution: 'Jordan, Founder',
  },
  Component: (p) => (
    <Section style={{ padding: '24px 0' }}>
      {p.heading ? (
        <Text style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 1, textAlign: 'center' }}>
          {p.heading}
        </Text>
      ) : null}
      <Quote quote={p.q1_quote} attribution={p.q1_attribution} />
      <Quote quote={p.q2_quote} attribution={p.q2_attribution} />
      <Quote quote={p.q3_quote} attribution={p.q3_attribution} />
    </Section>
  ),
};
