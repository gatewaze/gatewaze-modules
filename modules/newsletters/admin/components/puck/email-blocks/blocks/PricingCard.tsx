/**
 * Single pricing card — name + price + feature list + CTA. Suited for
 * "introducing our new tier" announcement emails.
 */

import { Button, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface PricingCardProps extends Record<string, unknown> {
  tier_name: string;
  price: string;
  period: string;
  feature_1: string;
  feature_2: string;
  feature_3: string;
  feature_4: string;
  cta_label: string;
  cta_url: string;
  accent_color: string;
}

export const PricingCardBlock: EmailBlockEntry<PricingCardProps> = {
  componentId: 'pricing_card',
  label: 'Pricing card',
  category: 'Pricing',
  fields: {
    tier_name: { type: 'text', label: 'Tier name' },
    price: { type: 'text', label: 'Price' },
    period: { type: 'text', label: 'Billing period' },
    feature_1: { type: 'text', label: 'Feature 1' },
    feature_2: { type: 'text', label: 'Feature 2' },
    feature_3: { type: 'text', label: 'Feature 3' },
    feature_4: { type: 'text', label: 'Feature 4 (optional)' },
    cta_label: { type: 'text', label: 'CTA label' },
    cta_url: { type: 'text', label: 'CTA URL' },
    accent_color: { type: 'text', label: 'Accent colour' },
  },
  defaultProps: {
    tier_name: 'Pro',
    price: '$29',
    period: 'per month',
    feature_1: 'Unlimited projects',
    feature_2: 'Advanced analytics',
    feature_3: 'Priority support',
    feature_4: '',
    cta_label: 'Start free trial',
    cta_url: '#',
    accent_color: '#2563EB',
  },
  Component: (p) => {
    const features = [p.feature_1, p.feature_2, p.feature_3, p.feature_4].filter((f) => f);
    return (
      <Section style={{ padding: '32px', backgroundColor: '#FFFFFF', border: `1px solid ${p.accent_color}`, borderRadius: 8 }}>
        <Text style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: p.accent_color, textTransform: 'uppercase', letterSpacing: 1 }}>
          {p.tier_name}
        </Text>
        <Text style={{ margin: '0 0 24px' }}>
          <span style={{ fontSize: 40, fontWeight: 700, color: '#111827' }}>{p.price}</span>
          <span style={{ fontSize: 14, color: '#6B7280', marginLeft: 6 }}>{p.period}</span>
        </Text>
        {features.map((f, i) => (
          <Text key={i} style={{ margin: '0 0 8px', fontSize: 14, color: '#111827' }}>
            <span style={{ color: p.accent_color, marginRight: 8 }}>✓</span>
            {f}
          </Text>
        ))}
        {p.cta_label && p.cta_url ? (
          <Button
            href={p.cta_url}
            style={{
              display: 'inline-block',
              marginTop: 24,
              backgroundColor: p.accent_color,
              color: '#FFFFFF',
              padding: '12px 24px',
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {p.cta_label}
          </Button>
        ) : null}
      </Section>
    );
  },
};
