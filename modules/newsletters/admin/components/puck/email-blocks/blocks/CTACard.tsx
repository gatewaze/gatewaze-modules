/**
 * CTA Card composite — centred logo + headline + button in a rounded
 * card. The "Start using {brand}" panel near the bottom of Barebone
 * `welcome.tsx` is the visual reference.
 *
 * Distinct from the bare `Button` primitive: this is the full call-
 * to-action block (with framing context) you'd typically place once
 * per edition above the footer. Use the `Button` primitive for
 * inline CTAs inside other sections.
 */

import { Button, Img, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface CTACardProps extends Record<string, unknown> {
  logo_url: string;
  headline: string;
  cta_label: string;
  cta_url: string;
  background: string;
}

export const CTACardBlock: EmailBlockEntry<CTACardProps> = {
  componentId: 'cta_card',
  label: 'CTA card',
  category: 'Action',
  fields: {
    logo_url: { type: 'custom', label: 'Logo (optional)', render: NewsletterImageFieldAdapter as never },
    headline: { type: 'textarea', label: 'Headline' },
    cta_label: { type: 'text', label: 'Button label' },
    cta_url: { type: 'text', label: 'Button URL' },
    background: { type: 'text', label: 'Background colour' },
  },
  defaultProps: {
    logo_url: '',
    headline: 'Ready to get started?\nThe fastest way to use this product.',
    cta_label: 'Open dashboard',
    cta_url: 'https://example.com',
    background: '#F3F4F6',
  },
  Component: ({ logo_url, headline, cta_label, cta_url, background }) => (
    <Section style={{ padding: '56px 32px', backgroundColor: background, borderRadius: 10, textAlign: 'center' }}>
      {logo_url ? (
        <Section style={{ marginBottom: 24, textAlign: 'center' }}>
          <Img
            src={logo_url}
            alt=""
            width={32}
            style={{ display: 'block', margin: '0 auto', backgroundColor: '#000', padding: 12, borderRadius: 12 }}
          />
        </Section>
      ) : null}
      <Text style={{ margin: '0 0 32px', fontSize: 28, color: '#43454B', textAlign: 'center', whiteSpace: 'pre-line' }}>
        {headline}
      </Text>
      {cta_label && cta_url ? (
        <Button
          href={cta_url}
          style={{ display: 'inline-block', backgroundColor: '#14171E', color: '#fff', padding: '16px 28px', borderRadius: 8, fontSize: 16, lineHeight: '1.5' }}
        >
          {cta_label}
        </Button>
      ) : null}
    </Section>
  ),
};
